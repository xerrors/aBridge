package dev.abridge.android

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceUnbindingTest {
    @Test
    fun onlyMatchingRevocationConfirmsCloudUnbinding() {
        val results = mutableListOf<Boolean>()
        val pending = DeviceUnbinding(7, results::add)
        pending.receive(JSONObject("""{"type":"revoke","connection_epoch":8}"""))
        pending.receive(JSONObject("""{"type":"heartbeat_ack","connection_epoch":7}"""))
        assertEquals(emptyList<Boolean>(), results)
        pending.receive(JSONObject("""{"type":"revoke","connection_epoch":7}"""))
        pending.finish(false)
        assertEquals(listOf(true), results)
    }

    @Test
    fun timeoutAndLateCallbacksDoNotCompleteANewerBinding() {
        val oldResults = mutableListOf<Boolean>()
        val newResults = mutableListOf<Boolean>()
        val old = DeviceUnbinding(7, oldResults::add)
        val current = DeviceUnbinding(8, newResults::add)
        old.finish(false)
        old.receive(JSONObject("""{"type":"revoke","connection_epoch":7}"""))
        old.finish(true)
        assertEquals(listOf(false), oldResults)
        assertEquals(emptyList<Boolean>(), newResults)
        current.finish(true)
        assertEquals(listOf(true), newResults)
    }
}
