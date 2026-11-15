// Event bridge: NSWorkspace activation + AXObserver callbacks on the main run loop drive ObserverCore.
// No timers, screenshots, screen recording, event taps or clipboard. Never prompts for Accessibility.
// Original implementation; no Screenpipe code.
import AppKit
import ApplicationServices
import ObserverCore

func writeLine(_ line: OutputLine) {
    FileHandle.standardOutput.write(Data((line.json + "\n").utf8))
}

/// Diagnostics carry no content text.
func diagnose(_ message: String) {
    FileHandle.standardError.write(Data("observer: \(message)\n".utf8))
}

struct LiveNode: AXNode {
    let element: AXUIElement

    private func attribute(_ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }

    var role: String? { attribute(kAXRoleAttribute) as? String }
    var subrole: String? { attribute(kAXSubroleAttribute) as? String }
    var url: String? {
        guard let value = attribute(kAXURLAttribute) else { return nil }
        return (value as? URL)?.absoluteString ?? (value as? String)
    }
    var text: String? { (attribute(kAXValueAttribute) as? String) ?? (attribute(kAXTitleAttribute) as? String) }
    var children: [LiveNode] { ((attribute(kAXChildrenAttribute) as? [AXUIElement]) ?? []).map(LiveNode.init) }
}

private let notifications = [
    kAXFocusedWindowChangedNotification, kAXFocusedUIElementChangedNotification,
    kAXTitleChangedNotification, kAXValueChangedNotification,
]

private let axCallback: AXObserverCallback = { _, element, _, _ in
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success else { return }
    MainActor.assumeIsolated { helper.trigger(pid: pid) } // sources are on the main run loop
}

@MainActor
final class Helper {
    let session = Session()
    private var observers: [pid_t: (observer: AXObserver, bundleId: String)] = [:]
    private var trusted = AXIsProcessTrusted() // check only; never the prompting variant
    private let worker = DispatchQueue(label: "observer.extract")
    private let stamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    func start() {
        // Bounds each AX call so an unresponsive app cannot hang us past the extraction budget for long.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.1)
        let center = NSWorkspace.shared.notificationCenter
        center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
            let pid = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
            MainActor.assumeIsolated {
                self.checkPermission()
                if let pid { self.trigger(pid: pid) }
            }
        }
        for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
            center.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { self.reconcile() }
            }
        }
        // Posted by the system when any app's Accessibility trust changes.
        DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name("com.apple.accessibility.api"), object: nil, queue: .main
        ) { _ in MainActor.assumeIsolated { self.checkPermission() } }

        reportState()
        let input = Thread {
            while let line = readLine(strippingNewline: true) {
                DispatchQueue.main.async { MainActor.assumeIsolated { helper.handle(line) } }
            }
            DispatchQueue.main.async { exit(0) } // parent closed stdin: never outlive it
        }
        input.start()
    }

    func handle(_ line: String) {
        switch parseControl(line) {
        case let .failure(error):
            diagnose("rejected control message: \(error.reason)")
        case .success(.stop):
            exit(0)
        case let .success(message):
            session.apply(message)
            reconcile()
            reportState()
            if let front = NSWorkspace.shared.frontmostApplication { trigger(pid: front.processIdentifier) }
        }
    }

    private func reportState() {
        writeLine(.status(!trusted ? "permission-missing" : session.paused ? "paused" : "ready"))
    }

    private func checkPermission() {
        let now = AXIsProcessTrusted()
        guard now != trusted else { return }
        trusted = now
        if !now { session.invalidate() }
        reconcile()
        reportState()
    }

    /// Observers exist only for running apps in the current scope, while trusted and not paused.
    func reconcile() {
        var wanted: [pid_t: String] = [:]
        if trusted {
            for app in NSWorkspace.shared.runningApplications {
                if let id = app.bundleIdentifier, session.allows(id) { wanted[app.processIdentifier] = id }
            }
        }
        for (pid, entry) in observers where wanted[pid] != entry.bundleId {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(entry.observer), .defaultMode)
            observers[pid] = nil
        }
        for (pid, bundleId) in wanted where observers[pid] == nil {
            var observer: AXObserver?
            guard AXObserverCreate(pid, axCallback, &observer) == .success, let observer else {
                diagnose("could not observe an allowed app")
                continue
            }
            let app = AXUIElementCreateApplication(pid)
            // Chromium/Electron build their accessibility tree only on request; no effect on other apps.
            AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            for name in notifications { AXObserverAddNotification(observer, app, name as CFString, nil) }
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
            observers[pid] = (observer, bundleId)
        }
    }

    /// Reads only the frontmost allowed app's focused window, at most one pending extraction per window.
    func trigger(pid: pid_t) {
        guard trusted, let bundleId = observers[pid]?.bundleId,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return }
        nonisolated(unsafe) let window = value as! AXUIElement
        let key = "\(pid)-\(CFHash(window))"
        guard session.request(window: key, bundleId: bundleId) else { return }
        worker.async {
            let ticket = DispatchQueue.main.sync { MainActor.assumeIsolated { helper.session.begin(window: key) } }
            guard let ticket else { return }
            let outcome = capture(bundleId: ticket.bundleId, window: LiveNode(element: window), scope: ticket.scope)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    let at = helper.stamp.string(from: Date())
                    if let line = helper.session.finish(ticket, outcome, capturedAt: at) { writeLine(line) }
                }
            }
        }
    }
}

let helper = Helper()
helper.start()
CFRunLoopRun()
