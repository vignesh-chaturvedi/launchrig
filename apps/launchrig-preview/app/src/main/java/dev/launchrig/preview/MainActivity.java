package dev.launchrig.preview;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.graphics.Insets;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private static final String DECK_URL = "https://launchrig.vercel.app/grant-deck/";
    private static final String DEMO_URL = "https://github.com/vignesh-chaturvedi/launchrig#watch-the-90-second-demo";
    private static final String SOURCE_URL = "https://github.com/vignesh-chaturvedi/launchrig";
    private static final String EVIDENCE_URL = "https://github.com/vignesh-chaturvedi/launchrig/tree/main/evidence/local-android-mwa-v2";

    private static final int BG = Color.rgb(16, 18, 22);
    private static final int SURFACE = Color.rgb(24, 28, 34);
    private static final int RAISED = Color.rgb(32, 40, 51);
    private static final int LINE = Color.rgb(50, 60, 73);
    private static final int TEXT = Color.rgb(240, 243, 248);
    private static final int MUTED = Color.rgb(170, 180, 194);
    private static final int BLUE = Color.rgb(147, 197, 253);
    private static final int GREEN = Color.rgb(146, 220, 180);
    private static final int AMBER = Color.rgb(240, 206, 135);

    private FrameLayout root;
    private WebView deck;
    private boolean deckOpen;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        if (Build.VERSION.SDK_INT >= 35) {
            root.setOnApplyWindowInsetsListener((view, windowInsets) -> {
                Insets bars = windowInsets.getInsets(WindowInsets.Type.systemBars());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return windowInsets;
            });
        }
        setContentView(root);
        showOverview();
    }

    private void showOverview() {
        deckOpen = false;
        disposeDeck();
        root.removeAllViews();

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(dp(24), dp(22), dp(24), dp(38));
        scroll.addView(page);
        root.addView(scroll);

        LinearLayout brand = row();
        brand.setGravity(Gravity.CENTER_VERTICAL);
        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.ion_wing);
        logo.setContentDescription("LaunchRig Ion Wing logo");
        brand.addView(logo, new LinearLayout.LayoutParams(dp(52), dp(52)));
        LinearLayout brandText = column();
        brandText.setPadding(dp(10), 0, 0, 0);
        brandText.addView(label("LaunchRig", 21, TEXT, true));
        brandText.addView(label("ANDROID PREVIEW  /  0.1", 10, BLUE, false));
        brand.addView(brandText);
        page.addView(brand);

        View topRule = rule();
        LinearLayout.LayoutParams topRuleParams = matchHeight(dp(1));
        topRuleParams.topMargin = dp(22);
        page.addView(topRule, topRuleParams);

        TextView kicker = label("PROOF BEFORE PROMISE", 11, BLUE, true);
        LinearLayout.LayoutParams kickerParams = wrap();
        kickerParams.topMargin = dp(44);
        page.addView(kicker, kickerParams);

        TextView headline = label("Inspect the\nreturn path.", 42, TEXT, true);
        headline.setLetterSpacing(-0.05f);
        headline.setLineSpacing(0, 0.96f);
        LinearLayout.LayoutParams headlineParams = wrap();
        headlineParams.topMargin = dp(14);
        page.addView(headline, headlineParams);

        TextView intro = label("A mobile companion for the LaunchRig developer-tooling grant. The testing CLI exists today. This app is a preview of the project, not the finished test runner.", 16, MUTED, false);
        intro.setLineSpacing(dp(4), 1f);
        LinearLayout.LayoutParams introParams = wrap();
        introParams.topMargin = dp(18);
        page.addView(intro, introParams);

        TextView preview = label("IN DEVELOPMENT  ·  LOCAL PREVIEW", 11, AMBER, true);
        preview.setGravity(Gravity.CENTER);
        preview.setBackground(shape(RAISED, LINE, 8));
        preview.setPadding(dp(12), dp(10), dp(12), dp(10));
        LinearLayout.LayoutParams previewParams = wrap();
        previewParams.topMargin = dp(26);
        page.addView(preview, previewParams);

        TextView deckButton = action("Explore the grant deck", true, this::showDeck);
        LinearLayout.LayoutParams deckButtonParams = matchHeight(ViewGroup.LayoutParams.WRAP_CONTENT);
        deckButtonParams.topMargin = dp(30);
        page.addView(deckButton, deckButtonParams);

        TextView demoButton = action("Watch the 90-second demo  ↗", false, () -> openExternal(DEMO_URL));
        LinearLayout.LayoutParams demoButtonParams = matchHeight(ViewGroup.LayoutParams.WRAP_CONTENT);
        demoButtonParams.topMargin = dp(10);
        page.addView(demoButton, demoButtonParams);

        section(page, "BUILD STATUS  /  23 SEP 2026", "Current build snapshot");
        statusCard(page, "01", "CLI test runner", "BUILT", GREEN,
            "Local commands, validation, and inspectable reports are available in the public source.");
        statusCard(page, "02", "Controlled Android proof", "BUILT", GREEN,
            "Three broken/fixed wallet-recovery cases were exercised with a Mock MWA wallet on one ordinary Android device.");
        statusCard(page, "03", "LaunchRig Android product", "PLANNED", AMBER,
            "This preview shows the project. Device-run controls, publisher workflows, and broader wallet validation are not in this app yet.");

        TextView evidenceButton = action("Inspect public evidence  ↗", false, () -> openExternal(EVIDENCE_URL));
        LinearLayout.LayoutParams evidenceParams = matchHeight(ViewGroup.LayoutParams.WRAP_CONTENT);
        evidenceParams.topMargin = dp(14);
        page.addView(evidenceButton, evidenceParams);

        section(page, "NEXT MILESTONE", "After grant funding");
        TextView roadmap = label("Build the full publisher-facing Android experience, run separately consented pilot tests, and validate on a Seeker when a device is available. None of those outcomes are claimed by this preview.", 15, MUTED, false);
        roadmap.setLineSpacing(dp(4), 1f);
        page.addView(roadmap);

        TextView sourceButton = action("Explore the open source  ↗", false, () -> openExternal(SOURCE_URL));
        LinearLayout.LayoutParams sourceParams = matchHeight(ViewGroup.LayoutParams.WRAP_CONTENT);
        sourceParams.topMargin = dp(24);
        page.addView(sourceButton, sourceParams);

        View bottomRule = rule();
        LinearLayout.LayoutParams bottomRuleParams = matchHeight(dp(1));
        bottomRuleParams.topMargin = dp(32);
        page.addView(bottomRule, bottomRuleParams);
        TextView footer = label("PREVIEW ONLY  /  NO WALLET CONNECTION  /  NO SEEKER CLAIM", 10, MUTED, false);
        LinearLayout.LayoutParams footerParams = wrap();
        footerParams.topMargin = dp(18);
        page.addView(footer, footerParams);
    }

    private void showDeck() {
        deckOpen = true;
        root.removeAllViews();
        LinearLayout shell = column();
        root.addView(shell);

        LinearLayout toolbar = row();
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(16), dp(10), dp(16), dp(10));
        TextView back = action("‹  Back", false, this::showOverview);
        toolbar.addView(back, new LinearLayout.LayoutParams(dp(100), dp(48)));
        TextView title = label("GRANT DECK", 11, BLUE, true);
        title.setGravity(Gravity.CENTER);
        toolbar.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));
        TextView browser = action("Open ↗", false, () -> openExternal(DECK_URL));
        toolbar.addView(browser, new LinearLayout.LayoutParams(dp(100), dp(48)));
        shell.addView(toolbar);
        shell.addView(rule(), matchHeight(dp(1)));

        FrameLayout content = new FrameLayout(this);
        shell.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        TextView loading = label("Loading the public grant deck…", 15, MUTED, false);
        loading.setGravity(Gravity.CENTER);

        deck = new WebView(this);
        deck.setBackgroundColor(BG);
        // The published deck needs JavaScript for slide controls. No JavaScript bridge is exposed.
        deck.getSettings().setJavaScriptEnabled(true);
        deck.getSettings().setDomStorageEnabled(false);
        deck.getSettings().setAllowFileAccess(false);
        deck.getSettings().setAllowContentAccess(false);
        deck.getSettings().setJavaScriptCanOpenWindowsAutomatically(false);
        deck.getSettings().setMediaPlaybackRequiresUserGesture(true);
        deck.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        deck.setWebViewClient(new WebViewClient() {
            private boolean loadFailed;

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (isDeckUrl(url)) return false;
                if (request.isForMainFrame()) openExternal(url.toString());
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!loadFailed) loading.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    loadFailed = true;
                    view.setVisibility(View.GONE);
                    loading.setText(R.string.deck_unavailable);
                }
            }
        });
        content.addView(deck, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        content.addView(loading, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        deck.loadUrl(DECK_URL);
    }

    private boolean isDeckUrl(Uri url) {
        return "https".equals(url.getScheme())
            && "launchrig.vercel.app".equals(url.getHost())
            && ("/grant-deck/".equals(url.getPath()) || "/grant-deck".equals(url.getPath()));
    }

    private void openExternal(String url) {
        Uri uri = Uri.parse(url);
        if (!"https".equals(uri.getScheme())) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (android.content.ActivityNotFoundException ignored) {
            android.widget.Toast.makeText(this, "No browser is available on this device.", android.widget.Toast.LENGTH_LONG).show();
        }
    }

    private void statusCard(LinearLayout page, String number, String title, String state, int stateColor, String detail) {
        LinearLayout card = column();
        card.setPadding(dp(18), dp(17), dp(18), dp(18));
        card.setBackground(shape(SURFACE, LINE, 10));
        LinearLayout top = row();
        top.setGravity(Gravity.CENTER_VERTICAL);
        TextView numberLabel = label(number, 11, BLUE, true);
        top.addView(numberLabel, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        top.addView(label(state, 10, stateColor, true));
        card.addView(top);
        TextView heading = label(title, 20, TEXT, true);
        LinearLayout.LayoutParams headingParams = wrap();
        headingParams.topMargin = dp(12);
        card.addView(heading, headingParams);
        TextView body = label(detail, 14, MUTED, false);
        body.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams bodyParams = wrap();
        bodyParams.topMargin = dp(9);
        card.addView(body, bodyParams);
        LinearLayout.LayoutParams cardParams = matchHeight(ViewGroup.LayoutParams.WRAP_CONTENT);
        cardParams.topMargin = dp(10);
        page.addView(card, cardParams);
    }

    private void section(LinearLayout page, String kicker, String heading) {
        TextView eyebrow = label(kicker, 11, BLUE, true);
        LinearLayout.LayoutParams eyebrowParams = wrap();
        eyebrowParams.topMargin = dp(42);
        page.addView(eyebrow, eyebrowParams);
        TextView headingView = label(heading, 26, TEXT, true);
        LinearLayout.LayoutParams headingParams = wrap();
        headingParams.topMargin = dp(8);
        headingParams.bottomMargin = dp(14);
        page.addView(headingView, headingParams);
    }

    private TextView action(String caption, boolean primary, Runnable click) {
        TextView button = label(caption, 14, primary ? BG : TEXT, true);
        button.setGravity(Gravity.CENTER);
        button.setMinHeight(dp(primary ? 54 : 48));
        button.setPadding(dp(12), dp(12), dp(12), dp(12));
        button.setBackground(shape(primary ? BLUE : SURFACE, primary ? BLUE : LINE, 8));
        button.setClickable(true);
        button.setFocusable(true);
        button.setOnClickListener(view -> click.run());
        return button;
    }

    private TextView label(String text, int sp, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(sp);
        view.setTextColor(color);
        view.setTypeface(bold ? Typeface.create("sans-serif-medium", Typeface.NORMAL) : Typeface.create("sans-serif", Typeface.NORMAL));
        return view;
    }

    private GradientDrawable shape(int fill, int stroke, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(radius));
        drawable.setStroke(dp(1), stroke);
        return drawable;
    }

    private View rule() {
        View view = new View(this);
        view.setBackgroundColor(LINE);
        return view;
    }

    private LinearLayout row() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.HORIZONTAL);
        return layout;
    }

    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private LinearLayout.LayoutParams wrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private LinearLayout.LayoutParams matchHeight(int height) {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height);
    }

    private int dp(float value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private void disposeDeck() {
        if (deck == null) return;
        deck.stopLoading();
        if (deck.getParent() instanceof ViewGroup) {
            ((ViewGroup) deck.getParent()).removeView(deck);
        }
        deck.destroy();
        deck = null;
    }

    @Override
    public void onBackPressed() {
        if (deckOpen) showOverview();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        disposeDeck();
        super.onDestroy();
    }
}
