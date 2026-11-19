package dev.abridge.android

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class DeviceService : AccessibilityService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS).build()
    private val prefs by lazy { devicePreferences }
    private val contract by lazy { DeviceContract(this) }
    private val screen by lazy { ScreenInput(this, contract.limits.getInt("imageBytes")) }
    private val files by lazy { WorkspaceFiles(this) }
    private val journal by lazy { getSharedPreferences("operations", Context.MODE_PRIVATE) }
    private var socket: WebSocket? = null
    private var maintenance: Job? = null
    private var reconnect: Job? = null
    private var epoch = 0L
    private var sequence = 0L
    private var deviceId = ""
    private var lease = 0L
    private var lastAck = 0L
    private var serverEpoch = 0.0
    private var grant = emptySet<String>()
    private var retries = 0
    private val closedSessions = mutableSetOf<String>()
    private data class Running(val id: String, val session: String, val capabilities: Set<String>, val job: Job)
    private var running: Running? = null
    private val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        when (key) {
            "key", "url" -> {
                disconnect()
                connect()
            }
            "paused", "tree", "screen", "input", "files" -> {
                // Maintain the input boundary even before the Server receives the update.
                if (key == "tree" || paused() || running?.capabilities?.any { !available(it) } == true) stopWork()
                if (key == "tree" || key == "screen" || key == "input" || paused()) screen.invalidate()
                if (epoch > 0) heartbeat()
            }
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            serviceInfo = serviceInfo.apply { flags = flags or AccessibilityServiceInfo.FLAG_INPUT_METHOD_EDITOR }
        }
        active = true
        prefs.registerOnSharedPreferenceChangeListener(listener)
        prefs.edit().remove("connection").apply()
        connect()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED ||
            event.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED) screen.invalidate()
    }
    override fun onInterrupt() { stopWork() }

    override fun onDestroy() {
        active = false
        prefs.unregisterOnSharedPreferenceChangeListener(listener)
        disconnect()
        scope.cancel()
        super.onDestroy()
    }

    private fun paused() = prefs.getBoolean("paused", true) || prefs.getBoolean("revoked", false)
    private fun available(name: String) = prefs.getBoolean(name, false) &&
        (name in listOf("screen", "input") || name == "files" && files.authorizedTree() != null)
    private fun capabilities() = JSONObject().apply {
        for (name in listOf("screen", "input", "files")) put(name, available(name))
    }

    private fun setState(state: String) { prefs.edit().putString("connection", state).apply() }

    private fun connect() {
        if (!active || socket != null || prefs.getBoolean("revoked", false)) return
        val url = prefs.getString("url", null)?.let(::serverAddress) ?: return
        val key = prefs.getString("key", null) ?: return
        setState("connecting")
        val request = Request.Builder().url("$url/ws/device").header("Authorization", "Bearer $key").build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { scope.launch {
                if (webSocket !== socket) return@launch
                send(JSONObject().put("type", "hello").put("protocol", contract.protocol)
                    .put("platform", "android").put("version", contract.version)
                    .put("capabilities", capabilities()).put("paused", paused()))
            } }
            override fun onMessage(webSocket: WebSocket, text: String) { scope.launch {
                if (webSocket !== socket) return@launch
                try {
                    require(text.toByteArray(Charsets.UTF_8).size <= contract.limits.getInt("messageBytes"))
                    receive(JSONObject(text))
                } catch (e: Exception) {
                    Log.w("aBridge", "Invalid device frame: ${e.javaClass.simpleName}")
                    scheduleReconnect()
                }
            } }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) { scope.launch {
                if (webSocket === socket) scheduleReconnect()
            } }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { scope.launch {
                if (webSocket === socket) scheduleReconnect()
            } }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { scope.launch {
                if (webSocket !== socket) return@launch
                Log.w("aBridge", "Connection failed: ${response?.code ?: t.javaClass.simpleName}")
                if (response?.code in setOf(401, 403)) revoke() else scheduleReconnect()
            } }
        })
        maintenance = scope.launch {
            delay(10000)
            if (epoch == 0L) scheduleReconnect()
        }
    }

    private fun send(frame: JSONObject) {
        val connection = socket ?: return
        if (!connection.send(frame.toString())) scheduleReconnect()
    }

    private fun heartbeat() = send(JSONObject().put("type", "heartbeat").put("connection_epoch", epoch)
        .put("capabilities", capabilities()).put("paused", paused()))

    private fun disconnect() {
        val prior = socket
        socket = null
        prior?.cancel()
        maintenance?.cancel()
        reconnect?.cancel()
        epoch = 0
        sequence = 0
        closedSessions.clear()
        stopWork()
        setState("offline")
    }

    private fun scheduleReconnect() {
        disconnect()
        val backoff = (1L shl retries.coerceAtMost(4)) * 1000
        retries++
        reconnect = scope.launch { delay(backoff); connect() }
    }

    private fun revoke() {
        prefs.edit().putBoolean("revoked", true).putBoolean("paused", true).commit()
        disconnect()
        setState("revoked")
    }

    private fun stopWork(session: String? = null) {
        if (session == null || running?.session == session) running?.job?.cancel()
        if (session == null) screen.invalidate() else screen.closeSession(session)
    }

    private fun receive(frame: JSONObject) {
        if (epoch == 0L) {
            require(contract.validate("welcome", frame))
            epoch = frame.getLong("connection_epoch")
            deviceId = frame.getString("device_id")
            grant = frame.getJSONArray("capabilities").values().filterIsInstance<String>().toSet()
            lease = (minOf(frame.getDouble("lease_seconds"), contract.limits.getDouble("leaseSeconds")) * 1000).toLong()
            updateClock(frame)
            retries = 0
            setState("online")
            maintenance?.cancel()
            maintenance = scope.launch {
                val interval = minOf(frame.getDouble("heartbeat_interval"), contract.limits.getDouble("heartbeatSeconds"))
                while (true) {
                    delay((interval * 1000).toLong().coerceAtLeast(1000))
                    if (SystemClock.elapsedRealtime() - lastAck >= lease) { scheduleReconnect(); break }
                    heartbeat()
                }
            }
            return
        }
        if (frame.optLong("connection_epoch") != epoch) return
        when (frame.optString("type")) {
            "heartbeat_ack" -> updateClock(frame)
            "dispatch" -> dispatch(frame)
            "stop" -> {
                prefs.edit().putBoolean("paused", true).commit()
                stopWork()
            }
            "revoke" -> revoke()
            "session_close" -> {
                val session = frame.getString("session_id")
                if (closedSessions.size >= contract.limits.getInt("journalEntries")) {
                    scheduleReconnect()
                    return
                }
                closedSessions.add(session)
                stopWork(session)
            }
            "cancel" -> {
                val active = running ?: return
                if (active.id in frame.getJSONArray("operation_ids").values()) stopWork(active.session)
            }
        }
    }

    private fun updateClock(frame: JSONObject) {
        val seconds = frame.get("server_time") as? Number ?: error("Missing server time")
        require(seconds.toDouble().isFinite() && seconds.toDouble() > 0)
        serverEpoch = seconds.toDouble()
        lastAck = SystemClock.elapsedRealtime()
    }

    private fun receipt(id: String, status: String, result: JSONObject = JSONObject(), error: Refusal? = null) {
        val payload = JSONObject().put("type", "result").put("connection_epoch", epoch)
            .put("operation_id", id).put("status", status).put("result", result)
        if (error != null) payload.put("error", JSONObject().put("code", error.code).put("message", error.message))
        send(payload)
    }

    private fun dispatch(frame: JSONObject) {
        val id = frame.opt("operation_id") as? String ?: return
        if (!identity.matches(id)) return
        fun refuse(code: String, message: String) = receipt(id, "refused", error = Refusal(code, message))
        if (!contract.validate("operation", frame)) return refuse("invalid_dispatch", "Invalid operation frame")
        if (frame.getString("device_id") != deviceId) return
        val session = frame.getString("session_id")
        if (!identity.matches(session)) return refuse("invalid_dispatch", "Invalid session ID")
        val expiry = frame.getDouble("expires_at")
        val now = serverEpoch + (SystemClock.elapsedRealtime() - lastAck) / 1000.0
        if (expiry <= now || expiry > now + contract.limits.getInt("operationStartSeconds") + contract.limits.getInt("operationGraceSeconds"))
            return refuse("dispatch_expired", "Operation start deadline expired")
        if (journal.contains(id)) return refuse("duplicate_operation", "This operation was already admitted")
        val seq = frame.getLong("sequence")
        if (seq <= sequence) return refuse("stale_sequence", "This operation sequence is stale")
        sequence = seq
        if (paused()) return refuse("device_paused", "Local access is paused")
        if (session in closedSessions) return refuse("session_closed", "This session is closed")
        if (SystemClock.elapsedRealtime() - lastAck >= lease) { scheduleReconnect(); return }
        val tool = frame.getString("tool")
        val args = frame.getJSONObject("arguments")
        if (tool !in supportedTools) return refuse("unsupported_tool", "Tool is unavailable on Android")
        if (!contract.validate(tool, args)) return refuse("invalid_arguments", "Arguments do not match the tool schema")
        val required = contract.required(tool, args)
        val sessionGrant = frame.getJSONArray("session_capabilities").values()
        if (required.isEmpty() || !required.all { it in grant && it in sessionGrant && available(it) })
            return refuse("capability_unavailable", "The required local capability is unavailable")
        if (running != null) return refuse("device_busy", "Another Android operation is running")
        // Preserve accepted identities across reconnects and process death. Fail closed when the bounded journal fills.
        if (journal.all.size >= contract.limits.getInt("journalEntries") ||
            !journal.edit().putBoolean(id, true).commit())
            return refuse("journal_unavailable", "The local operation journal is unavailable")

        val connection = socket
        val operation = scope.launch(start = kotlinx.coroutines.CoroutineStart.LAZY) {
            var status = "executed"
            var result = JSONObject()
            var failure: Refusal? = null
            try {
                result = withTimeout(25000) {
                    val execution = coroutineContext
                    val check = {
                        execution.ensureActive()
                        if (paused() || required.any { !prefs.getBoolean(it, false) })
                            throw CancellationException("Local authorization changed")
                    }
                    check()
                    when (tool) {
                        "computer_observe" -> screen.observe(session, args, check)
                        "computer_act" -> screen.act(session, args, check)
                        else -> withContext(Dispatchers.IO) { files.execute(tool, args, check) }
                    }
                }
            } catch (e: Refusal) {
                status = "refused"
                failure = e
            } catch (_: Exception) {
                status = "outcome_unknown"
                failure = Refusal("outcome_unknown", "Android could not confirm the result. Do not replay this operation")
                screen.closeSession(session)
            } finally {
                running = null
                if (socket != null && connection === socket && epoch > 0) receipt(id, status, result, failure)
            }
        }
        running = Running(id, session, required, operation)
        operation.start()
    }

    internal companion object {
        @Volatile var active = false
            private set
        private val identity = Regex("^[A-Za-z0-9_-]{1,100}$")
        private val supportedTools = setOf("computer_observe", "computer_act", "files_list", "file_read", "file_write")
    }
}
