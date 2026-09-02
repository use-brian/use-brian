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
        let prompt = request.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, prompt.utf16.count <= 8_000 else {
            throw AskBrianError.invalidRequest
        }

        var components = URLComponents()
        components.scheme = "usebrian"
        components.host = "ask"
        components.queryItems = [URLQueryItem(name: "prompt", value: prompt)]

        guard let url = components.url else {
            throw AskBrianError.invalidRequest
        }

        let opened = await MainActor.run {
            NSWorkspace.shared.open(url)
        }
        guard opened else {
            throw AskBrianError.couldNotOpenBrian
        }

        return .result(dialog: "Opening Brian with your request.")
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
            "Please give Brian a request between 1 and 8,000 characters."
        case .couldNotOpenBrian:
            "I couldn't open Use Brian. Please install the app in Applications and open it once."
        }
    }
}
