import UIKit
import Capacitor

/// The app's root view controller. Same as CAPBridgeViewController, plus registration of the custom
/// Face ID plugin (npm plugins are registered by Capacitor from capacitor.config.json; this one is local).
class HawweshViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        // The app header is dark navy in both light and dark mode, so the status bar text must be light.
        statusBarStyle = .lightContent
        bridge?.registerPluginInstance(HawweshBiometricsPlugin())
    }
}
