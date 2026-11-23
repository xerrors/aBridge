package dev.abridge.android

import android.app.Activity
import android.app.AlertDialog
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.WebMessage
import android.webkit.WebMessagePort
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.window.OnBackInvokedDispatcher
import java.net.IDN
import java.net.URI
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

internal val Context.devicePreferences get() = getSharedPreferences("device", Context.MODE_PRIVATE)

internal fun serverAddress(raw: String): String? {
    val input = runCatching { URI(raw.trim()) }.getOrNull() ?: return null
    val scheme = input.scheme?.lowercase() ?: return null
    if ((scheme != "http" && scheme != "https") || input.rawQuery != null || input.rawFragment != null) return null
    val authority = input.rawAuthority ?: return null
    if ('@' in authority || '%' in authority) return null
    val url = runCatching {
        val asciiAuthority = if (authority.any { it.code > 127 }) {
            val host = authority.substringBefore(':')
            IDN.toASCII(host, IDN.USE_STD3_ASCII_RULES) + authority.removePrefix(host)
        } else authority
        URI("$scheme://$asciiAuthority${input.rawPath.orEmpty()}").parseServerAuthority().normalize()
    }.getOrNull() ?: return null
    val host = url.host?.lowercase() ?: return null
    if (url.port != -1 && url.port !in 1..65535) return null
    val defaultPort = if (scheme == "http") 80 else 443
    val port = if (url.port == -1 || url.port == defaultPort) "" else ":${url.port}"
    return URI("$scheme://$host$port${url.rawPath.orEmpty()}").toASCIIString().trimEnd('/')
}

internal fun approvedServerAddress(raw: String, confirmedHttp: String?, debug: Boolean = BuildConfig.DEBUG): String? {
    val address = serverAddress(raw) ?: return null
    if (address.startsWith("https://") || address == confirmedHttp) return address
    return address.takeIf { debug && URI(it).host in listOf("127.0.0.1", "10.0.2.2") }
}

internal enum class ConnectionStatus {
    Online, Connecting, Offline, ServiceUnavailable, KeyRequired, Revoked, Unbound,
}

internal enum class LocalCapability(val preference: String) {
    Screen("screen"),
    Input("input"),
    Files("files"),
}

class SettingsActivity : Activity() {
    private val preferences by lazy { devicePreferences }
    private val workspace by lazy { WorkspaceFiles(this) }
    private var webView: WebView? = null
    private var reply: WebMessagePort? = null
    private var httpDialog: AlertDialog? = null
    private val updates = Executors.newSingleThreadExecutor()
    private var unbindSequence = 0
    private var availableUpdate: AppUpdates.Release? = null
    private var updateStatus = JSONObject().put("type", "update").put("status", "idle")
    private val settingsListener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> refresh() }
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setDecorFitsSystemWindows(false)
        if (Build.VERSION.SDK_INT < 35) {
            @Suppress("DEPRECATION")
            window.statusBarColor = 0xfffafafa.toInt()
            @Suppress("DEPRECATION")
            window.navigationBarColor = 0xfffafafa.toInt()
        }
        val barsAppearance = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
            WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, ::goBack)
        }
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        val view = WebView(this)
        webView = view
        view.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val url = request.url
                val path = url.encodedPath.orEmpty().removePrefix("/assets/")
                if (request.method == "GET" && url.scheme == "https" && url.encodedAuthority == ORIGIN_HOST &&
                    url.encodedPath.orEmpty().startsWith("/assets/") && url.encodedQuery == null &&
                    path.split('/').all { segment -> segment.isNotEmpty() && segment != "." && segment != ".." } &&
                    path.none { it == '%' || it == '\\' } && (!request.isForMainFrame || url.toString() == PAGE)
                ) {
                    val mime = when (path.substringAfterLast('.')) {
                        "html" -> "text/html"
                        "js" -> "text/javascript"
                        "css" -> "text/css"
                        "svg" -> "image/svg+xml"
                        else -> null
                    }
                    val input = mime?.let { runCatching { assets.open(path) }.getOrNull() }
                    if (input != null) return WebResourceResponse(mime, "UTF-8", input)
                }
                return WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(byteArrayOf()))
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                reply?.close()
                reply = null
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (url != PAGE || view.url != PAGE || reply != null) return
                val (local, remote) = view.createWebMessageChannel()
                reply = local
                local.setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
                    override fun onMessage(port: WebMessagePort, message: WebMessage) {
                        if (port !== reply || view.url != PAGE) return
                        runCatching { JSONObject(message.data.orEmpty()) }.getOrNull()?.let(::handle)
                    }
                })
                view.postWebMessage(WebMessage("aBridgeNative", arrayOf(remote)), Uri.parse(ORIGIN))
            }
        }
        preferences.registerOnSharedPreferenceChangeListener(settingsListener)
        val container = android.widget.FrameLayout(this).apply {
            setBackgroundColor(0xfffafafa.toInt())
            addView(view, android.widget.FrameLayout.LayoutParams(-1, -1))
        }
        container.setOnApplyWindowInsetsListener { target, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            target.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsets.CONSUMED
        }
        setContentView(container)
        window.insetsController?.setSystemBarsAppearance(barsAppearance, barsAppearance)
        view.loadUrl(PAGE)
    }

    // Android 13+ dispatches back through the framework callback registered above.
    @SuppressLint("GestureBackNavigation")
    @Deprecated("Android 12 and earlier back navigation")
    override fun onBackPressed() = goBack()

    private fun goBack() {
        if (reply == null) finish() else send(JSONObject().put("type", "back"))
    }

    @Deprecated("Framework directory picker result")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == DIRECTORY_PICKER && resultCode == RESULT_OK && data != null) acceptDirectory(data)
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
                if (address == null) {
                    sendError("请输入完整的 HTTP 或 HTTPS 服务器地址")
                    return
                }
                if (key.length > 512 || key.any { it !in '!'..'~' }) {
                    sendError("Device Key 格式无效")
                    return
                }
                if (address.startsWith("http://")) confirmHttpBinding(address, key)
                else if (httpDialog == null) bind(address, key)
            }
            "standby" -> (request.opt("enabled") as? Boolean)?.let { enabled ->
                preferences.edit().putBoolean("background_standby", enabled).commit()
                if (enabled && Build.VERSION.SDK_INT >= 33 &&
                    checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED)
                    requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 2)
            }
            "batterySettings" -> startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            "access" -> (request.opt("allowed") as? Boolean)?.let(::setAgentAccess)
            "capability" -> {
                val capability = LocalCapability.entries.find { it.preference == request.optString("name") }
                val enabled = request.opt("enabled") as? Boolean
                if (capability != null && enabled != null) setCapability(capability, enabled)
            }
            "accessibility" -> startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            "directory" -> startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), DIRECTORY_PICKER)
            "revokeDirectory" -> revokeDirectory()
            "unbind" -> unbind()
            "checkUpdate" -> checkUpdate()
            "updateNotes" -> availableUpdate?.let { openUpdatePage(it.notes) }
            "downloadUpdate" -> availableUpdate?.let { openUpdatePage(it.download) }
            "exit" -> finish()
        }
    }

    private fun send(message: JSONObject) {
        reply?.postMessage(WebMessage(message.toString()))
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
        updates.execute {
            val result = runCatching { AppUpdates.find() }
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                result.fold(
                    onSuccess = { release ->
                        availableUpdate = release
                        sendUpdate(if (release == null) "latest" else "available")
                    },
                    onFailure = { failure ->
                        sendUpdate("error", (failure as? IllegalStateException)?.message ?: "检查更新失败，请检查网络后重试")
                    },
                )
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
        updates.shutdownNow()
        httpDialog?.dismiss()
        httpDialog = null
        preferences.unregisterOnSharedPreferenceChangeListener(settingsListener)
        reply?.close()
        reply = null
        webView?.let { view ->
            (view.parent as? android.view.ViewGroup)?.removeView(view)
            view.destroy()
        }
        webView = null
        super.onDestroy()
    }

    private fun confirmHttpBinding(address: String, key: String) {
        if (httpDialog != null) return
        var accepted = false
        httpDialog = AlertDialog.Builder(this)
            .setTitle("使用未加密的 HTTP 连接？")
            .setMessage((if (key.isEmpty()) "操作数据" else "Device Key 和操作数据") +
                "将通过 HTTP 明文传输。请仅在信任的网络中继续。\n\n$address")
            .setNegativeButton("取消", null)
            .setPositiveButton("使用 HTTP 绑定") { _, _ ->
                accepted = true
                bind(address, key)
            }
            .setOnDismissListener {
                httpDialog = null
                if (!accepted && !isDestroyed) send(JSONObject().put("type", "bindingCancelled"))
            }
            .show()
    }

    private fun bind(address: String, key: String) {
        preferences.edit().putString("url", address).putString("key", key)
            .putString("confirmed_http_url", address.takeIf { it.startsWith("http://") })
            .putBoolean("paused", true).putBoolean("revoked", false).apply()
        DeviceService.rebind()
        send(JSONObject().put("type", "bound"))
        refresh()
    }

    private fun setAgentAccess(allowed: Boolean) {
        if (!preferences.contains("key") || preferences.getBoolean("revoked", false)) return
        preferences.edit().putBoolean("paused", !allowed).commit()
    }

    private fun setCapability(capability: LocalCapability, enabled: Boolean) {
        preferences.edit().putBoolean(capability.preference, enabled).commit()
    }

    private fun unbind() {
        if (!preferences.contains("key")) return
        val address = preferences.getString("url", "").orEmpty()
        val sequence = ++unbindSequence
        DeviceService.unbind { cloudRevoked ->
            webView?.post {
                if (!cloudRevoked && !isDestroyed && sequence == unbindSequence && !preferences.contains("key")) {
                    sendError("已解除本机绑定，未确认 Server 撤销。请在 $address 管理台撤销旧设备。")
                }
            }
        }
        preferences.edit().remove("key").remove("confirmed_http_url").remove("revoked")
            .putBoolean("paused", true).commit()
        send(JSONObject().put("type", "unbound"))
        refresh()
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
            revoked && preferences.getString("key", null).isNullOrEmpty() -> ConnectionStatus.KeyRequired
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
            .put("standbyEnabled", preferences.getBoolean("background_standby", false))
            .put("standbyActive", preferences.getBoolean("standby_active", false))
            .put("batteryUnrestricted", getSystemService(android.os.PowerManager::class.java).isIgnoringBatteryOptimizations(packageName))
            .put("interactionState", interactionState().wire)
            .put("agentAllowed", bound && !revoked && !preferences.getBoolean("paused", true))
            .put("enabledCapabilities", JSONArray(enabled.map { it.preference }))
            .put("grantedCapabilities", JSONArray(DeviceService.grantedCapabilities))
            .put("directoryAuthorized", workspace.authorizedTree() != null)
            .put("accessibilityActive", serviceActive)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("model", Build.MODEL)
            .put("androidVersion", Build.VERSION.RELEASE))
    }

    private companion object {
        const val DIRECTORY_PICKER = 1
        const val ORIGIN_HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$ORIGIN_HOST"
        const val PAGE = "$ORIGIN/assets/index.html"
        const val DIRECTORY_FLAGS = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    }
}
