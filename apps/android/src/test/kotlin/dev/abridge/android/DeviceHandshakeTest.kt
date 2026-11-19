package dev.abridge.android

import org.java_websocket.enums.Role
import org.java_websocket.exceptions.InvalidHandshakeException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.nio.ByteBuffer

class DeviceHandshakeTest {
    @Test
    fun onlyUnauthorizedUpgradeResponsesRevokeCredentials() {
        for (status in listOf(401, 403, 503)) {
            var rejected = false
            val draft = DeviceHandshake(4096) { rejected = true }.copyInstance()
            draft.setParseMode(Role.CLIENT)
            assertThrows(InvalidHandshakeException::class.java) {
                draft.translateHandshake(ByteBuffer.wrap("HTTP/1.1 $status Test\r\n\r\n".toByteArray()))
            }
            assertEquals(status in listOf(401, 403), rejected)
        }
    }
}
