import SwiftUI

@main
struct BrianSiriApp: App {
    init() {
        BrianShortcuts.updateAppShortcutParameters()
    }

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}
