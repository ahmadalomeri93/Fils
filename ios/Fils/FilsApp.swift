import SwiftUI
import WebKit
import UniformTypeIdentifiers

// فلس كتطبيق آيفون: نفس ملفات dist/ مضمّنة داخل التطبيق وتشتغل بدون نت.
// الملفات تنقدّم من app://fils/ عشان ES modules و localStorage يشتغلون مثل الموقع.

@main
struct FilsApp: App {
    var body: some Scene {
        WindowGroup {
            FilsWebView()
                .ignoresSafeArea()
                .background(Color(red: 0.03, green: 0.05, blue: 0.09))
        }
    }
}

struct FilsWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(context.coordinator.schemeHandler, forURLScheme: BundleSchemeHandler.scheme)
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true

        // ميزات الآيفون (Face ID والتذكيرات) تنحقن بدون تعديل ملفات الموقع
        let features = context.coordinator.features
        let content = config.userContentController
        content.add(features, name: "hawwesh")
        content.addUserScript(WKUserScript(source: features.bootstrapScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if let url = Bundle.main.url(forResource: "native-bridge", withExtension: "js"),
           let bridge = try? String(contentsOf: url, encoding: .utf8) {
            content.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = true
        context.coordinator.webView = webView
        features.webView = webView
        if SmokeReport.enabled {
            content.addUserScript(WKUserScript(source: SmokeReport.errorCollector, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        features.lockOnLaunchIfNeeded()
        webView.load(URLRequest(url: URL(string: "\(BundleSchemeHandler.scheme)://fils/index.html")!))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
        let schemeHandler = BundleSchemeHandler()
        let features = NativeFeatures()
        weak var webView: WKWebView?
        private var downloadURLs: [ObjectIdentifier: URL] = [:]

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { SmokeReport.capture(webView) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { SmokeReport.write(["navigationError": "\(error)"]) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { SmokeReport.write(["navigationError": "\(error)"]) }

        // الروابط الخارجية (مثل بورصة الكويت) تنفتح بـSafari، وتصدير النسخة الاحتياطية ينزل كملف.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, preferences: WKWebpagePreferences, decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
            if action.shouldPerformDownload {
                decisionHandler(.download, preferences)
                return
            }
            guard let url = action.request.url else { decisionHandler(.cancel, preferences); return }
            if url.scheme == BundleSchemeHandler.scheme && action.targetFrame == nil {
                // رابط يطلب نافذة جديدة (مثل «اقرأ سياسة الخصوصية»): التطبيق ما عنده نوافذ، فنفتحه بنفس الصفحة
                webView.load(action.request)
                decisionHandler(.cancel, preferences)
                return
            }
            if url.scheme == BundleSchemeHandler.scheme || url.scheme == "blob" || url.scheme == "data" || url.scheme == "about" {
                decisionHandler(.allow, preferences)
            } else {
                UIApplication.shared.open(url)
                decisionHandler(.cancel, preferences)
            }
        }

        // window.open و target=_blank اللي ما مرّت من فوق
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url {
                if url.scheme == BundleSchemeHandler.scheme { webView.load(navigationAction.request) } else { UIApplication.shared.open(url) }
            }
            return nil
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(suggestedFilename)
            try? FileManager.default.removeItem(at: url)
            downloadURLs[ObjectIdentifier(download)] = url
            completionHandler(url)
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let url = downloadURLs.removeValue(forKey: ObjectIdentifier(download)) else { return }
            shareFile(url)
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            if let url = downloadURLs.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: url) }
            notify("النسخة الاحتياطية ما انحفظت. اضغط «تصدير نسخة» وجرّب مرة ثانية.")
        }

        // الصفحة تقول «تم تجهيز النسخة» قبل لا تنفتح قائمة الحفظ، فإذا انلغت أو فشلت نقول للمستخدم بوضوح
        private func notify(_ message: String) {
            present(UIAlertController(title: nil, message: message, preferredStyle: .alert), actions: [UIAlertAction(title: "تم", style: .default)], fallback: {})
        }

        private func shareFile(_ url: URL) {
            guard let webView, let root = webView.window?.rootViewController else {
                try? FileManager.default.removeItem(at: url)
                notify("ما قدرت أفتح قائمة الحفظ. اضغط «تصدير نسخة» وجرّب مرة ثانية.")
                return
            }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            // الملف فيه كل بياناتك المالية بنص صريح: يُحذف من مجلد التطبيق المؤقت بمجرد ما تنتهي المشاركة
            sheet.completionWithItemsHandler = { [weak self] _, completed, _, _ in
                try? FileManager.default.removeItem(at: url)
                if !completed { self?.notify("النسخة الاحتياطية ما انحفظت. اضغط «تصدير نسخة» واختر مكان الحفظ (مثل «حفظ في الملفات»).") }
            }
            sheet.popoverPresentationController?.sourceView = webView
            sheet.popoverPresentationController?.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 0, height: 0)
            (root.presentedViewController ?? root).present(sheet, animated: true)
        }

        // نوافذ التأكيد (confirm/alert/prompt) اللي يستخدمها التطبيق
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            present(UIAlertController(title: nil, message: message, preferredStyle: .alert), actions: [UIAlertAction(title: "تم", style: .default) { _ in completionHandler() }], fallback: completionHandler)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            present(UIAlertController(title: nil, message: message, preferredStyle: .alert), actions: [
                UIAlertAction(title: "إلغاء", style: .cancel) { _ in completionHandler(false) },
                UIAlertAction(title: "موافق", style: .default) { _ in completionHandler(true) }
            ], fallback: { completionHandler(false) })
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            present(alert, actions: [
                UIAlertAction(title: "إلغاء", style: .cancel) { _ in completionHandler(nil) },
                UIAlertAction(title: "موافق", style: .default) { _ in completionHandler(alert.textFields?.first?.text) }
            ], fallback: { completionHandler(nil) })
        }

        private func present(_ alert: UIAlertController, actions: [UIAlertAction], fallback: @escaping () -> Void) {
            guard let root = webView?.window?.rootViewController else { fallback(); return }
            actions.forEach(alert.addAction)
            (root.presentedViewController ?? root).present(alert, animated: true)
        }
    }
}

// يقدّم ملفات الموقع المضمّنة (مجلد dist داخل التطبيق) بأنواع MIME الصحيحة.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "app"
    private let root = Bundle.main.resourceURL!.appendingPathComponent("dist", isDirectory: true)

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path.removingPercentEncoding ?? url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let fileURL = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL

        guard fileURL.path.hasPrefix(root.standardizedFileURL.path),
              let data = try? Data(contentsOf: fileURL) else {
            let response = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!
            task.didReceive(response)
            task.didFinish()
            return
        }
        let mime = Self.mimeType(for: fileURL.pathExtension)
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": mime,
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache"
        ])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "webmanifest": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "woff2": return "font/woff2"
        case "wasm": return "application/wasm"
        default: return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}


// فحص دخان للبناء الآلي فقط (GitHub Actions): لو فُتح التطبيق بالوسيط -smoke يكتب حالة الصفحة بعد التحميل
// بملف Documents/smoke.json عشان يقرأه الـworkflow. بدون الوسيط ما يسوي شي.
enum SmokeReport {
    static var enabled: Bool { ProcessInfo.processInfo.arguments.contains("-smoke") }

    static let errorCollector = """
    window.__smokeErrors = [];
    window.addEventListener('error', function (e) { window.__smokeErrors.push(String(e.message) + ' @' + String(e.filename || '') + ':' + String(e.lineno || 0)); });
    window.addEventListener('unhandledrejection', function (e) { window.__smokeErrors.push('rejection: ' + String(e.reason)); });
    """

    private static let probe = """
    (function () {
      var ls; try { localStorage.setItem('__smoke', '1'); ls = localStorage.getItem('__smoke') === '1'; localStorage.removeItem('__smoke'); } catch (e) { ls = String(e); }
      var disp = function (sel) { var el = document.querySelector(sel); return el ? getComputedStyle(el).display : 'missing'; };
      var active = document.querySelector('.view.active');
      return JSON.stringify({
        title: document.title, url: location.href, activeView: active ? active.id : null,
        bodyTextLength: document.body ? document.body.innerText.length : 0,
        localStorageWorks: ls, bridge: !!window.__hawwesh,
        isSecureContext: window.isSecureContext === true, cryptoSubtle: !!(window.crypto && window.crypto.subtle),
        jsRendered: ['daily-progress', 'flow-caption', 'budget-progress'].filter(function (id) { var el = document.getElementById(id); return el && el.textContent.trim().length > 0; }).length,
        nativeSection: !!document.getElementById('hawwesh-native'),
        nativeOnlyShown: Array.prototype.filter.call(document.querySelectorAll('span.native-only'), function (el) { return getComputedStyle(el).display !== 'none'; }).length,
        nativeOnlyTotal: document.querySelectorAll('span.native-only').length,
        assistantNavDisplay: disp('[data-target="assistant"]'), assistantViewDisplay: disp('#assistant-view'),
        webOnlyShown: Array.prototype.filter.call(document.querySelectorAll('.web-only'), function (el) { return getComputedStyle(el).display !== 'none'; }).length,
        errors: window.__smokeErrors || []
      });
    })()
    """

    static func capture(_ webView: WKWebView) {
        guard enabled else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
            webView.evaluateJavaScript(probe) { result, error in
                if let text = result as? String { write(raw: text) } else { write(["probeError": "\(String(describing: error))"]) }
            }
        }
    }

    static func write(_ info: [String: String]) {
        guard enabled, let data = try? JSONSerialization.data(withJSONObject: info), let text = String(data: data, encoding: .utf8) else { return }
        write(raw: text)
    }

    private static func write(raw text: String) {
        guard enabled, let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        try? text.write(to: dir.appendingPathComponent("smoke.json"), atomically: true, encoding: .utf8)
    }
}
