package dev.abridge.android

import org.json.JSONObject

/** A retired connection may only complete its own revocation, never mutate binding state. */
internal class DeviceUnbinding(
    private val epoch: Long,
    private val complete: (Boolean) -> Unit,
) {
    private var finished = false

    fun receive(frame: JSONObject) {
        if (frame.optString("type") == "revoke" && frame.optLong("connection_epoch") == epoch) finish(true)
    }

    fun finish(confirmed: Boolean) {
        if (finished) return
        finished = true
        complete(confirmed)
    }
}
