package dev.abridge.android

import android.app.Activity
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

internal val Context.devicePreferences get() = getSharedPreferences("device", Context.MODE_PRIVATE)

internal fun serverAddress(raw: String): String? {
    val url = raw.trim().toHttpUrlOrNull() ?: return null
    if (url.username.isNotEmpty() || url.password.isNotEmpty() || url.query != null || url.fragment != null) return null
    if (!url.isHttps && !(BuildConfig.DEBUG && url.host in listOf("10.0.2.2", "127.0.0.1"))) return null
    return url.toString().trimEnd('/')
}

internal enum class ConnectionStatus(val label: String) {
    Online("已连接"),
    Connecting("连接中"),
    Offline("离线"),
    ServiceUnavailable("无障碍未连接"),
    Revoked("凭据已撤销"),
    Unbound("尚未绑定"),
}

internal enum class LocalCapability(val preference: String) {
    Screen("screen"),
    Input("input"),
    Files("files"),
}

class SettingsActivity : ComponentActivity() {
    private val preferences by lazy { devicePreferences }
    private val workspace by lazy { WorkspaceFiles(this) }
    private var webView: WebView? = null
    private var reply: JavaScriptReplyProxy? = null
    private val updatesScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var availableUpdate: AppUpdates.Release? = null
    private var updateStatus = JSONObject().put("type", "update").put("status", "idle")
    private val settingsListener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> refresh() }
    private val directoryPicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) result.data?.let(::acceptDirectory)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val chromeBars = SystemBarStyle.light(0xfffafafa.toInt(), 0xfffafafa.toInt())
        enableEdgeToEdge(statusBarStyle = chromeBars, navigationBarStyle = chromeBars)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            setContentView(TextView(this).apply { text = "请更新 Android System WebView 后重新打开 aBridge。" })
            return
        }

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        val view = WebView(this)
        webView = view
        view.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.toString() != PAGE

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
                assets.shouldInterceptRequest(request.url)
                    ?: WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(byteArrayOf()))

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                reply = null
            }
        }
        WebViewCompat.addWebMessageListener(view, "aBridgeNative", setOf(ORIGIN)) { _, message, origin, mainFrame, sender ->
            if (mainFrame && origin.toString() == ORIGIN) {
                val request = runCatching { JSONObject(message.data ?: "") }.getOrNull()
                if (request != null) {
                    reply = sender
                    handle(request)
                }
            }
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (reply == null) finish() else send(JSONObject().put("type", "back"))
            }
        })
        preferences.registerOnSharedPreferenceChangeListener(settingsListener)
        val container = android.widget.FrameLayout(this).apply {
            setBackgroundColor(0xfffafafa.toInt())
            addView(view, android.widget.FrameLayout.LayoutParams(-1, -1))
        }
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(container) { target, insets ->
            val bars = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars())
            val keyboard = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())
            target.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            androidx.core.view.WindowInsetsCompat.CONSUMED
        }
        setContentView(container)
        view.loadUrl(PAGE)
    }

    private fun handle(request: JSONObject) {
        when (request.optString("type")) {
            "ready" -> {
                refresh()
                send(updateStatus)
            }
            "bind" -> {
                val address = serverAddress(request.optString("address"))
                val key = request.optString("key").trim()
                if (address == null || key.isEmpty() || key.length > 512 || key.any { it !in '!'..'~' }) {
                    if (address == null && request.optString("address").trim().startsWith("http://", ignoreCase = true))
                        sendError("此地址使用 HTTP。请输入以 https:// 开头的服务器地址。")
                    else sendError("请输入有效的 Server 地址和 Device Key")
                    return
                }
                bind(address, key)
                send(JSONObject().put("type", "bound"))
                refresh()
            }
            "access" -> (request.opt("allowed") as? Boolean)?.let(::setAgentAccess)
            "capability" -> {
                val capability = LocalCapability.entries.find { it.preference == request.optString("name") }
                val enabled = request.opt("enabled") as? Boolean
                if (capability != null && enabled != null) setCapability(capability, enabled)
            }
            "accessibility" -> startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            "directory" -> directoryPicker.launch(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE))
            "revokeDirectory" -> revokeDirectory()
            "unbind" -> unbind()
            "checkUpdate" -> checkUpdate()
            "updateNotes" -> availableUpdate?.let { openUpdatePage(it.notes) }
            "downloadUpdate" -> availableUpdate?.let { openUpdatePage(it.download) }
            "exit" -> finish()
        }
    }

    private fun send(message: JSONObject) {
        reply?.postMessage(message.toString())
    }

    private fun sendError(message: String) {
        send(JSONObject().put("type", "error").put("message", message))
    }

    private fun sendUpdate(status: String, message: String? = null) {
        updateStatus = JSONObject().put("type", "update").put("status", status)
            .put("version", availableUpdate?.version).put("message", message)
        send(updateStatus)
    }

    private fun checkUpdate() {
        if (updateStatus.optString("status") == "checking") return
        availableUpdate = null
        sendUpdate("checking")
        updatesScope.launch {
            try {
                availableUpdate = withContext(Dispatchers.IO) { AppUpdates.find() }
                sendUpdate(if (availableUpdate == null) "latest" else "available")
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (failure: IllegalStateException) {
                sendUpdate("error", failure.message ?: "检查更新失败，请稍后重试")
            } catch (_: Exception) {
                sendUpdate("error", "检查更新失败，请检查网络后重试")
            }
        }
    }

    private fun openUpdatePage(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: android.content.ActivityNotFoundException) {
            sendUpdate("available", "未找到可打开更新链接的浏览器")
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    override fun onDestroy() {
        updatesScope.cancel()
        preferences.unregisterOnSharedPreferenceChangeListener(settingsListener)
        reply = null
        webView?.let { view ->
            (view.parent as? android.view.ViewGroup)?.removeView(view)
            view.destroy()
        }
        webView = null
        super.onDestroy()
    }

    private fun bind(address: String, key: String) {
        preferences.edit().putString("url", address).putString("key", key)
            .putBoolean("paused", true).putBoolean("revoked", false).commit()
    }

    private fun setAgentAccess(allowed: Boolean) {
        if (!preferences.contains("key") || preferences.getBoolean("revoked", false)) return
        preferences.edit().putBoolean("paused", !allowed).commit()
    }

    private fun setCapability(capability: LocalCapability, enabled: Boolean) {
        preferences.edit().putBoolean(capability.preference, enabled).commit()
    }

    private fun unbind() {
        preferences.edit().remove("key").putBoolean("paused", true).commit()
    }

    private fun acceptDirectory(data: Intent) {
        val uri = data.data ?: return
        if (data.flags and DIRECTORY_FLAGS != DIRECTORY_FLAGS || runCatching {
                contentResolver.takePersistableUriPermission(uri, DIRECTORY_FLAGS)
            }.isFailure) {
            sendError("该目录未提供持久读写授权")
            return
        }
        val previous = selectedDirectory()
        preferences.edit().putString("tree", uri.toString()).commit()
        if (previous != null && previous != uri) releaseDirectory(previous)
        refresh()
    }

    private fun revokeDirectory() {
        val previous = selectedDirectory()
        preferences.edit().remove("tree").commit()
        if (previous != null) releaseDirectory(previous)
    }

    private fun selectedDirectory() = preferences.getString("tree", null)?.let(Uri::parse)

    private fun releaseDirectory(uri: Uri) {
        runCatching { contentResolver.releasePersistableUriPermission(uri, DIRECTORY_FLAGS) }
    }

    private fun refresh() {
        val bound = preferences.contains("key")
        val serviceActive = DeviceService.active
        val revoked = preferences.getBoolean("revoked", false)
        val connection = when {
            !bound -> ConnectionStatus.Unbound
            revoked -> ConnectionStatus.Revoked
            !serviceActive -> ConnectionStatus.ServiceUnavailable
            else -> when (preferences.getString("connection", null)) {
                "online" -> ConnectionStatus.Online
                "connecting" -> ConnectionStatus.Connecting
                else -> ConnectionStatus.Offline
            }
        }
        val enabled = LocalCapability.entries.filter { preferences.getBoolean(it.preference, false) }
        send(JSONObject().put("type", "state")
            .put("bound", bound)
            .put("server", preferences.getString("url", "").orEmpty())
            .put("connection", connection.name)
            .put("agentAllowed", bound && !revoked && !preferences.getBoolean("paused", true))
            .put("enabledCapabilities", JSONArray(enabled.map { it.preference }))
            .put("directoryAuthorized", workspace.authorizedTree() != null)
            .put("accessibilityActive", serviceActive)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("debug", BuildConfig.DEBUG)
            .put("model", Build.MODEL)
            .put("androidVersion", Build.VERSION.RELEASE))
    }

    private companion object {
        const val ORIGIN = "https://appassets.androidplatform.net"
        const val PAGE = "$ORIGIN/assets/index.html"
        const val DIRECTORY_FLAGS = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    }
}
