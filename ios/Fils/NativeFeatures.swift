import UIKit
import WebKit
import LocalAuthentication
import UserNotifications

// ميزات آيفون الأصلية لحوّش: قفل Face ID وتذكيرات الراتب والأقساط.
// الواجهة تنحقن من native-bridge.js (بدون ما نعدّل ملفات الموقع)، وتكلّمنا عن طريق رسائل "hawwesh".

final class NativeFeatures: NSObject, WKScriptMessageHandler {
    static let faceIDKey = "faceIDEnabled"
    static let remindersKey = "remindersEnabled"

    weak var webView: WKWebView?
    private var lockView: UIView?
    private var isAuthenticating = false
    private var locked = false
    private var lastSnapshot: [String: Any] = [:]

    private var defaults: UserDefaults { .standard }
    var faceIDEnabled: Bool { defaults.bool(forKey: Self.faceIDKey) }
    var remindersEnabled: Bool { defaults.bool(forKey: Self.remindersKey) }

    // قيم البداية للواجهة المحقونة
    var bootstrapScript: String {
        let biometry = Self.biometryName()
        return "window.__hawwesh = { faceID: \(faceIDEnabled), reminders: \(remindersEnabled), biometry: \"\(biometry)\" };"
    }

    override init() {
        super.init()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(willResignActive), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    // MARK: رسائل من الصفحة

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "setFaceID":
            let on = body["value"] as? Bool ?? false
            if on {
                authenticate(reason: "فعّل قفل حوّش") { [weak self] ok in
                    self?.defaults.set(ok, forKey: Self.faceIDKey)
                    self?.reportState()
                }
            } else {
                defaults.set(false, forKey: Self.faceIDKey)
                reportState()
            }
        case "setReminders":
            let on = body["value"] as? Bool ?? false
            if on {
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] granted, _ in
                    DispatchQueue.main.async {
                        guard let self else { return }
                        self.defaults.set(granted, forKey: Self.remindersKey)
                        self.scheduleReminders()
                        self.reportState()
                    }
                }
            } else {
                defaults.set(false, forKey: Self.remindersKey)
                scheduleReminders()
                reportState()
            }
        case "snapshot":
            lastSnapshot = body
            scheduleReminders()
        default:
            break
        }
    }

    private func reportState() {
        webView?.evaluateJavaScript("window.__hawwesh && window.__hawwesh.update && window.__hawwesh.update(\(faceIDEnabled), \(remindersEnabled))")
    }

    // MARK: قفل Face ID

    // نافذة Face ID نفسها تخلي التطبيق "غير نشط" بدون ما يروح للخلفية،
    // فالقفل يصير بس لما التطبيق يروح للخلفية، والغطاء بقائمة التطبيقات للخصوصية.
    @objc private func willResignActive() {
        if faceIDEnabled && !isAuthenticating { showLock() }
    }

    @objc private func didEnterBackground() {
        if faceIDEnabled { locked = true; showLock() }
    }

    @objc private func didBecomeActive() {
        guard faceIDEnabled, locked else { if !isAuthenticating { hideLock() }; return }
        unlock()
    }

    func lockOnLaunchIfNeeded() {
        if faceIDEnabled { locked = true; showLock() }
    }

    private func unlock() {
        guard !isAuthenticating else { return }
        showLock()
        authenticate(reason: "افتح حوّش") { [weak self] ok in
            guard ok else { return }
            self?.locked = false
            self?.hideLock()
        }
    }

    private func showLock() {
        guard lockView == nil, let host = webView?.superview ?? webView else { return }
        let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterialDark))
        blur.frame = host.bounds
        blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        let button = UIButton(type: .system)
        button.setTitle("🔒 افتح حوّش", for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 20, weight: .bold)
        button.tintColor = .white
        button.translatesAutoresizingMaskIntoConstraints = false
        button.accessibilityLabel = "افتح حوّش"
        blur.accessibilityViewIsModal = true
        button.addAction(UIAction { [weak self] _ in self?.unlock() }, for: .touchUpInside)
        blur.contentView.addSubview(button)
        NSLayoutConstraint.activate([
            button.centerXAnchor.constraint(equalTo: blur.contentView.centerXAnchor),
            button.centerYAnchor.constraint(equalTo: blur.contentView.centerYAnchor)
        ])
        host.addSubview(blur)
        webView?.accessibilityElementsHidden = true
        UIAccessibility.post(notification: .screenChanged, argument: button)
        lockView = blur
    }

    private func hideLock() {
        lockView?.removeFromSuperview()
        lockView = nil
        webView?.accessibilityElementsHidden = false
    }

    private func authenticate(reason: String, completion: @escaping (Bool) -> Void) {
        let context = LAContext()
        var error: NSError?
        // deviceOwnerAuthentication: Face ID وإذا فشل يطلب رمز الجهاز، فما ينقفل أحد برا تطبيقه
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            completion(false)
            return
        }
        isAuthenticating = true
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { [weak self] ok, _ in
            DispatchQueue.main.async {
                self?.isAuthenticating = false
                completion(ok)
            }
        }
    }

    static func biometryName() -> String {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        default: return "رمز الجهاز"
        }
    }

    // MARK: التذكيرات

    private func scheduleReminders() {
        let center = UNUserNotificationCenter.current()
        center.removeAllPendingNotificationRequests()
        guard remindersEnabled else { return }

        var requests: [UNNotificationRequest] = []

        if let salaryDay = lastSnapshot["salaryDay"] as? Int, (1...31).contains(salaryDay) {
            requests.append(contentsOf: monthly(id: "salary", day: salaryDay, hour: 9,
                                    title: "يوم الراتب 💰",
                                    body: "حوّش قبل لا تصرف: حط جزء للادخار أول شي."))
        }

        let loans = (lastSnapshot["loans"] as? [[String: Any]]) ?? []
        for (index, loan) in loans.prefix(50).enumerated() {
            guard let day = loan["dueDay"] as? Int, (1...31).contains(day) else { continue }
            let name = (loan["name"] as? String) ?? "قسط"
            let fils = (loan["installmentFils"] as? Int) ?? 0
            let amount = String(format: "%.3f د.ك", Double(fils) / 1000)
            let id = (loan["id"] as? String) ?? "loan-\(index)"
            requests.append(contentsOf: monthly(id: "loan-\(id)", day: day, hour: 9,
                                    title: "قسط اليوم: \(name)",
                                    body: "القسط \(amount). تأكد إن رصيدك يكفي."))
        }

        // iOS يسمح بـ64 تذكير معلّق بالكثير
        requests.prefix(60).forEach { center.add($0) }
    }

    // الأيام 1–28 تتكرر كل شهر. الأيام 29–31 ما توجد بكل الشهور، فنجدولها للشهور الستة الجاية واحد واحد
    // (آخر يوم بالشهر القصير مثل ما يسوي التطبيق بحساباته)، ويتجدد الجدول كل ما انفتح التطبيق.
    // التقويم ميلادي دايماً لأن كل تواريخ حوّش ميلادية حتى لو الجهاز على التقويم الهجري.
    private func monthly(id: String, day: Int, hour: Int, title: String, body: String) -> [UNNotificationRequest] {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let calendar = Calendar(identifier: .gregorian)
        if day <= 28 {
            var date = DateComponents(calendar: calendar)
            date.day = day
            date.hour = hour
            let trigger = UNCalendarNotificationTrigger(dateMatching: date, repeats: true)
            return [UNNotificationRequest(identifier: id, content: content, trigger: trigger)]
        }
        var requests: [UNNotificationRequest] = []
        let now = Date()
        for offset in 0..<6 {
            guard let month = calendar.date(byAdding: .month, value: offset, to: now),
                  let days = calendar.range(of: .day, in: .month, for: month) else { continue }
            var date = calendar.dateComponents([.year, .month], from: month)
            date.calendar = calendar
            date.day = min(day, days.count)
            date.hour = hour
            guard let fire = calendar.date(from: date), fire > now else { continue }
            let trigger = UNCalendarNotificationTrigger(dateMatching: date, repeats: false)
            requests.append(UNNotificationRequest(identifier: "\(id)-\(date.year ?? 0)-\(date.month ?? 0)", content: content, trigger: trigger))
        }
        return requests
    }
}
