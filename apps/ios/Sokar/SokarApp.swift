import SwiftUI
import WebKit

let suppernoteDashboardURL = URL(string: "https://suppernote.com/dashboard")!

@main
struct SuppernoteApp: App {
    var body: some Scene {
        WindowGroup {
            SuppernoteRootView().preferredColorScheme(.dark)
        }
    }
}

struct SuppernoteRootView: View {
    @State private var attempt = 0
    @State private var failed = false

    var body: some View {
        ZStack {
            Color(red: 3/255, green: 3/255, blue: 3/255).ignoresSafeArea()
            if failed {
                ContentUnavailableView {
                    Text("Impossible de charger Suppernote.")
                } description: {
                    Text("Vérifiez votre connexion.")
                } actions: {
                    Button("Réessayer") {
                        failed = false
                        attempt += 1
                    }
                }
            } else {
                // Changer attempt recrée le WKWebView pour un nouvel essai.
                SuppernoteWebView(url: suppernoteDashboardURL, onFailure: { failed = true })
                    .id(attempt)
                    .ignoresSafeArea()
            }
        }
    }
}

struct SuppernoteWebView: UIViewRepresentable {
    let url: URL
    let onFailure: () -> Void

    final class Coordinator: NSObject, WKNavigationDelegate, WKDownloadDelegate {
        let onFailure: () -> Void
        private var fileURL: URL?

        init(onFailure: @escaping () -> Void) {
            self.onFailure = onFailure
            super.init()
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // Avant la logique de liens : un téléchargement sortant partirait dans Safari.
            if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
            guard let url = navigationAction.request.url else { decisionHandler(.allow); return }
            let host = url.host ?? ""
            let isInternal = host == "suppernote.com" || host.hasSuffix(".suppernote.com")
            // Seul un clic sortant quitte l'appli : une redirection de connexion reste dedans.
            // targetFrame nil = target="_blank" : sans fenêtre à ouvrir, on passe par Safari.
            let opensOutside = ["tel", "mailto", "sms"].contains(url.scheme ?? "")
                || navigationAction.targetFrame == nil
                || (navigationAction.navigationType == .linkActivated && !isInternal)
            if opensOutside {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            // NSURLErrorCancelled est une annulation, pas une panne.
            if (error as NSError).code != NSURLErrorCancelled { onFailure() }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled { onFailure() }
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
            download.delegate = self
        }

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
            let destination = FileManager.default.temporaryDirectory.appendingPathComponent(suggestedFilename)
            // WKDownload échoue si le fichier existe déjà.
            try? FileManager.default.removeItem(at: destination)
            fileURL = destination
            completionHandler(destination)
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let fileURL else { return }
            share(fileURL)
        }

        private func share(_ fileURL: URL) {
            let window = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }.first { $0.isKeyWindow }
            guard let window else { return }
            guard var top = window.rootViewController else { return }
            while let presented = top.presentedViewController { top = presented }
            let sheet = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
            // Sans ancre de popover, la présentation plante sur iPad.
            sheet.popoverPresentationController?.sourceView = top.view
            sheet.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
            top.present(sheet, animated: true)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onFailure: onFailure)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Le dashboard reconnaît la coque (bannière d'installation masquée).
        // Garde le jeton « Mobile/… » par défaut de WebKit, que les sites lisent pour détecter un mobile.
        configuration.applicationNameForUserAgent = "Mobile/15E148 SuppernoteIOS"
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 3/255, green: 3/255, blue: 3/255, alpha: 1)
        webView.scrollView.backgroundColor = UIColor(red: 3/255, green: 3/255, blue: 3/255, alpha: 1)
        // Le dashboard gère lui-même les safe areas.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
