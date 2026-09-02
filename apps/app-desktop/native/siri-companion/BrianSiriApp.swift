import AppKit

@main
enum BrianSiriApp {
    private static let appDelegate = BrianSiriAppDelegate()

    static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        application.delegate = appDelegate
        application.run()
    }
}

private final class BrianSiriAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        BrianShortcuts.updateAppShortcutParameters()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}
