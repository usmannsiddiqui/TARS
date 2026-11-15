// swift-tools-version: 6.0
// Selected-app text observer and the hold-to-talk key helper. ObserverCore holds the pure, testable policy (scope, budgets, sequencing);
// the observer executable only wires it to NSWorkspace / AXObserver events on the main run loop.
import PackageDescription

let package = Package(
    name: "observer",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "ObserverCore", path: "Sources/Observer/Core"),
        .executableTarget(name: "observer", dependencies: ["ObserverCore"], path: "Sources/Observer/App"),
        // Hold-to-talk: reports only whether Right Option is held (NSEvent flagsChanged monitor).
        .executableTarget(name: "holdkey", path: "Sources/HoldKey"),
        .testTarget(name: "ObserverTests", dependencies: ["ObserverCore"], path: "Tests/ObserverTests"),
    ]
)
