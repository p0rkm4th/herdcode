package com.hckrslsh.herdcode;

import android.app.Activity;
import android.os.Bundle;
import android.view.Window;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * HERDCODE shell: a fullscreen WebView hosting the single-file client
 * (assets/index.html). The client is responsive by CSS breakpoint, and
 * the manifest's configChanges (orientation|screenSize|smallestScreenSize|
 * screenLayout|density) mean folding/unfolding the Fold 6 does NOT
 * recreate the activity -- an in-flight token stream survives the fold.
 *
 * Network posture: the page is loaded from file:// and fetches the
 * user's own tailnet endpoints over http. That needs cleartext allowed
 * (manifest) and mixed-content allowed (below). Endpoints must never be
 * exposed beyond the tailnet; see the app's README.
 */
public class MainActivity extends Activity {

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        web = new WebView(this);
        web.setBackgroundColor(0xFF0A0B0E); // match the client's --bg

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);       // settings + sessions in localStorage
        s.setAllowFileAccess(true);         // file:///android_asset/
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        // file:// page -> http:// tailnet endpoints is "mixed content"
        // to a WebView; the tailnet is the trust boundary here.
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        web.setWebViewClient(new WebViewClient());
        setContentView(web);
        if (savedInstanceState == null) {
            web.loadUrl("file:///android_asset/index.html");
        } else {
            web.restoreState(savedInstanceState);
        }
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }
}
