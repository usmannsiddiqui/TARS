// Hold-to-talk key helper: reports only whether Right Option is held, as {"type":"hold","down":true|false}.
// A listen-only NSEvent monitor for modifier changes (flagsChanged) on the main run loop: it never sees
// typed characters or other keys' codes, never blocks or alters an event, and uses no timers or event taps.
// macOS delivers key-related global events only to an Accessibility-trusted process. This never prompts;
// it reports "permission-missing" and re-arms when the system says Accessibility trust changed.
import AppKit
import ApplicationServices

let rightOptionKeyCode: UInt16 = 61
let rightOptionDeviceMask: UInt = 0x40 // NX_DEVICERALTKEYMASK

func writeLine(_ json: String) {
    FileHandle.standardOutput.write(Data((json + "\n").utf8))
}

@MainActor
final class HoldKey {
    private var monitor: Any?
    private var trusted = false
    private var down = false

    func start() {
        DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name("com.apple.accessibility.api"), object: nil, queue: .main
        ) { _ in MainActor.assumeIsolated { self.check() } }
        trusted = AXIsProcessTrusted() // check only; never the prompting variant
        arm()
        Thread {
            while readLine() != nil {}
            DispatchQueue.main.async { exit(0) } // parent closed stdin: never outlive it
        }.start()
    }

    private func check() {
        let now = AXIsProcessTrusted()
        guard now != trusted else { return }
        trusted = now
        arm()
    }

    private func arm() {
        if trusted, monitor == nil {
            monitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { event in
                let keyCode = event.keyCode
                let held = event.modifierFlags.rawValue & rightOptionDeviceMask != 0
                MainActor.assumeIsolated { self.changed(keyCode: keyCode, held: held) }
            }
        } else if !trusted, let active = monitor {
            NSEvent.removeMonitor(active)
            monitor = nil
            set(false)
        }
        writeLine(#"{"type":"status","status":"\#(trusted && monitor != nil ? "ready" : "permission-missing")"}"#)
    }

    private func changed(keyCode: UInt16, held: Bool) {
        if keyCode == rightOptionKeyCode { set(held) }
    }

    private func set(_ next: Bool) {
        guard next != down else { return }
        down = next
        writeLine(#"{"type":"hold","down":\#(next)}"#)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited) // no Dock icon, no menu bar, never focus
let holdKey = HoldKey()
holdKey.start()
app.run()
