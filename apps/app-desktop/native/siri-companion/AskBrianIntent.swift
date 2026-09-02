import AppIntents
import AppKit

struct AskBrianIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Brian"
    static let description = IntentDescription("Send a request to Use Brian.")
    static let openAppWhenRun = false

    @Parameter(title: "Request")
    var request: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask Brian \(\.$request)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        var components = URLComponents()
        components.scheme = "usebrian"
        components.host = "ask"
        components.queryItems = [URLQueryItem(name: "prompt", value: request)]

        guard let url = components.url else {
            throw AskBrianError.invalidRequest
        }

        let opened = await MainActor.run {
            NSWorkspace.shared.open(url)
        }
        guard opened else {
            throw AskBrianError.couldNotOpenBrian
        }

        return .result(dialog: "I sent that to Brian.")
    }
}

struct BrianShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskBrianIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Tell \(.applicationName)",
            ],
            shortTitle: "Ask Brian",
            systemImageName: "bubble.left.and.text.bubble.right"
        )
    }
}

private enum AskBrianError: Error, CustomLocalizedStringResourceConvertible {
    case invalidRequest
    case couldNotOpenBrian

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .invalidRequest:
            "I couldn't understand that request."
        case .couldNotOpenBrian:
            "I couldn't open Use Brian. Please install or open the app first."
        }
    }
}
