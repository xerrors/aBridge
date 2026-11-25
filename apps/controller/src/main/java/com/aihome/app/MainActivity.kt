package com.aihome.app

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.speech.RecognizerIntent
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayInputStream

/** Independent controller: no receiver service, device credentials or accessibility privileges. */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private var policy: ServerPolicy? = null
    private var voiceDocument: String? = null
    private var navigationGeneration = 0
    private var voiceGeneration = -1
    private var voicePending = false
    private var fileResult: ValueCallback<Array<Uri>>? = null
    private var fileGeneration = -1
    private val preferences by lazy { getSharedPreferences("controller-settings", MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.WHITE) }
        root.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        val header = LinearLayout(this).apply { gravity = android.view.Gravity.CENTER_VERTICAL; setPadding(20, 4, 12, 4) }
        header.addView(TextView(this).apply { text = getString(R.string.app_name); textSize = 18f }, LinearLayout.LayoutParams(0, 48.dp, 1f))
        header.addView(Button(this).apply { text = "服务器"; setOnClickListener { settings() } })
        root.addView(header)
        web = WebView(this)
        root.addView(web, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !request.isForMainFrame || policy?.trustedDocument(request.url.toString()) != true

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val current = policy
                if (current?.sameOrigin(request.url.toString()) != true ||
                    (request.isForMainFrame && !current.trustedDocument(request.url.toString()))) {
                    return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                }
                return null
            }
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                navigationGeneration++
                voiceDocument = null
                if (policy?.trustedDocument(url) != true) view.stopLoading()
            }
            override fun onPageFinished(view: WebView, url: String) {
                if (policy?.trustedDocument(url) == true && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                    view.evaluateJavascript("""
                        window.aBridgeController = Object.freeze({
                          startVoiceInput: () => window.controllerVoice.postMessage('start'),
                          cancelVoiceInput: () => window.controllerVoice.postMessage('cancel')
                        });
                        window.dispatchEvent(new Event('abridge:native-ready'));
                    """.trimIndent(), null)
                }
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                if (request.isForMainFrame) android.widget.Toast.makeText(this@MainActivity, "无法连接服务器，请检查服务器地址与网络", android.widget.Toast.LENGTH_LONG).show()
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                if (policy?.trustedDocument(view.url ?: "") != true || params.mode != FileChooserParams.MODE_OPEN) return false
                fileResult?.onReceiveValue(null)
                fileResult = callback
                fileGeneration = navigationGeneration
                try {
                    startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "image/*"
                    }, IMAGE_REQUEST)
                } catch (_: ActivityNotFoundException) { fileResult = null; callback.onReceiveValue(null) }
                return true
            }
        }
        val address = preferences.getString("origin", null)
        if (address == null) settings() else connect(address, preferences.getBoolean("local-http", false), false)
    }

    private fun connect(address: String, allowLocal: Boolean, clearSession: Boolean) {
        val next = ServerPolicy(address, allowLocal)
        navigationGeneration++
        voiceDocument = null
        policy = next
        web.stopLoading()
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.removeWebMessageListener(web, "controllerVoice")
            WebViewCompat.addWebMessageListener(web, "controllerVoice", setOf(next.origin)) { _, message, sourceOrigin, isMainFrame, _ ->
                if (isMainFrame && policy === next && next.sameOrigin(sourceOrigin.toString()) && next.trustedDocument(web.url ?: "")) {
                    when (message.data) {
                        "start" -> startVoice()
                        "cancel" -> { voiceDocument = null; if (voicePending) finishActivity(VOICE_REQUEST); emit("state", JSONObject().put("state", "idle")) }
                    }
                }
            }
        }
        preferences.edit().putString("origin", next.origin).putBoolean("local-http", allowLocal).apply()
        if (clearSession) {
            web.clearHistory()
            web.clearCache(true)
            WebStorage.getInstance().deleteAllData()
            CookieManager.getInstance().removeAllCookies { web.loadUrl(next.controllerUrl) }
        } else web.loadUrl(next.controllerUrl)
    }

    private fun settings() {
        val panel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24.dp, 8.dp, 24.dp, 4.dp) }
        val address = EditText(this).apply {
            hint = "https://bridge.example.com"
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            setText(preferences.getString("origin", ""))
        }
        val local = CheckBox(this).apply { text = "允许本机 / 模拟器调试 HTTP"; isChecked = preferences.getBoolean("local-http", false) }
        val error = TextView(this).apply { setTextColor(Color.RED) }
        panel.addView(address); panel.addView(local); panel.addView(error)
        val dialog = AlertDialog.Builder(this).setTitle("连接控制端服务器").setView(panel)
            .setPositiveButton("连接", null).setNegativeButton("取消", null).create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                try {
                    val next = ServerPolicy(address.text.toString(), local.isChecked)
                    connect(next.origin, local.isChecked, next.origin != policy?.origin)
                    dialog.dismiss()
                } catch (exception: Exception) { error.text = exception.message ?: "服务器地址无效" }
            }
        }
        dialog.show()
    }

    private fun startVoice() {
        if (voicePending) return
        voiceDocument = web.url
        voiceGeneration = navigationGeneration
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PROMPT, "说出任务内容")
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        }
        try {
            startActivityForResult(intent, VOICE_REQUEST)
            voicePending = true
            emit("state", JSONObject().put("state", "listening"))
        } catch (_: ActivityNotFoundException) {
            voiceDocument = null
            emit("error", JSONObject().put("message", "此设备没有语音识别服务，请使用键盘输入"))
        } catch (_: SecurityException) {
            voiceDocument = null
            emit("error", JSONObject().put("message", "系统无法启动语音输入，请检查语音服务权限"))
        }
    }

    @Deprecated("Activity result bridge for platform speech UI")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == IMAGE_REQUEST) {
            val callback = fileResult
            fileResult = null
            val uri = data?.data
            val allowed = resultCode == RESULT_OK && fileGeneration == navigationGeneration &&
                policy?.trustedDocument(web.url ?: "") == true && uri?.scheme == "content"
            callback?.onReceiveValue(if (allowed && uri != null) arrayOf(uri) else null)
            return
        }
        if (requestCode != VOICE_REQUEST) return
        voicePending = false
        val original = voiceDocument
        voiceDocument = null
        if (original == null || voiceGeneration != navigationGeneration || original != web.url) return
        if (resultCode == RESULT_OK) {
            val text = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim()
            if (!text.isNullOrEmpty()) emit("result", JSONObject().put("text", text))
            else emit("error", JSONObject().put("message", "未识别到文字，请重试"))
        }
        emit("state", JSONObject().put("state", "idle"))
    }

    private fun emit(event: String, detail: JSONObject) {
        if (policy?.trustedDocument(web.url ?: "") != true) return
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent(${JSONObject.quote("abridge:voice-$event")},{detail:$detail}));", null)
    }
    override fun onDestroy() { voiceDocument = null; fileResult?.onReceiveValue(null); fileResult = null; web.destroy(); super.onDestroy() }
    private val Int.dp get() = (this * resources.displayMetrics.density).toInt()
    companion object { private const val VOICE_REQUEST = 1601; private const val IMAGE_REQUEST = 1602 }
}
