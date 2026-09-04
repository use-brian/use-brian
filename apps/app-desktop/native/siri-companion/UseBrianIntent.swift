import AppIntents
import AppKit

struct UseBrianIntent: AppIntent {
    static let title: LocalizedStringResource = "Use Brian"
    static let description = IntentDescription("Send a request to Use Brian.")
    static let openAppWhenRun = false

    @Parameter(title: "Request")
    var request: String

    static var parameterSummary: some ParameterSummary {
        Summary("Use Brian \(\.$request)")
    }

    func perform() async throws -> some IntentResult {
        try await openUseBrian(request)
        return .result()
    }
}

struct BrianShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: UseBrianIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Tell \(.applicationName)",
            ],
            shortTitle: "Use Brian",
            systemImageName: "bubble.left.and.text.bubble.right"
        )
    }
}

private enum UseBrianError: Error, CustomLocalizedStringResourceConvertible {
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

private func openUseBrian(_ request: String) async throws {
    let prompt = request.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !prompt.isEmpty, prompt.utf16.count <= 8_000 else {
        throw UseBrianError.invalidRequest
    }

    var components = URLComponents()
    components.scheme = "usebrian"
    components.host = "use"
    components.queryItems = [URLQueryItem(name: "prompt", value: prompt)]

    guard let url = components.url else {
        throw UseBrianError.invalidRequest
    }

    let opened = await MainActor.run {
        NSWorkspace.shared.open(url)
    }
    guard opened else {
        throw UseBrianError.couldNotOpenBrian
    }
}

/**
 * The bundled Apple-signed shortcut was serialized with this identifier.
 * Keep it hidden and forward to the active Use Brian implementation.
 */
struct AskBrianIntent: AppIntent {
    static let title: LocalizedStringResource = "Use Brian"
    static let description = IntentDescription("Compatibility bridge for existing Use Brian shortcuts.")
    static let openAppWhenRun = false
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Request")
    var request: String

    static var parameterSummary: some ParameterSummary {
        Summary("Use Brian \(\.$request)")
    }

    func perform() async throws -> some IntentResult {
        try await openUseBrian(request)
        return .result()
    }
}
