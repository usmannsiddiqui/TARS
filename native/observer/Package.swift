// swift-tools-version: 6.0
// Selected-app text observer. ObserverCore holds the pure, testable policy (scope, budgets, sequencing);
// the observer executable only wires it to NSWorkspace / AXObserver events on the main run loop.
import PackageDescription

let package = Package(
    name: "observer",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "ObserverCore", path: "Sources/Observer/Core"),
        .executableTarget(name: "observer", dependencies: ["ObserverCore"], path: "Sources/Observer/App"),
        .testTarget(name: "ObserverTests", dependencies: ["ObserverCore"], path: "Tests/ObserverTests"),
    ]
)
