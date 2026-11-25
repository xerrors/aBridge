package com.aihome.app

import org.junit.Assert.*
import org.junit.Test

class ServerPolicyTest {
    @Test fun productionOriginAndExactController() {
        val policy = ServerPolicy("https://bridge.example:443/", false)
        assertEquals("https://bridge.example", policy.origin)
        assertTrue(policy.trustedDocument("https://bridge.example/controller/"))
        assertTrue(policy.trustedDocument("https://bridge.example/controller?task=1"))
        listOf("https://evil.example/controller/", "https://bridge.example/", "https://bridge.example/admin", "https://bridge.example/controller/evil", "https://bridge.example/%63ontroller/", "https://bridge.example:444/controller/", "https://user@bridge.example/controller/").forEach {
            assertFalse(it, policy.trustedDocument(it))
        }
    }
    @Test fun rejectUnsafeConfiguration() {
        listOf("http://bridge.example", "http://127.0.0.1:8765", "https://user:pass@bridge.example", "https://bridge.example/admin", "https://bridge.example?secret=x", "file:///controller/", "https://bridge.example:0").forEach {
            assertThrows(it, IllegalArgumentException::class.java) { ServerPolicy(it, false) }
        }
        assertThrows(IllegalArgumentException::class.java) { ServerPolicy("http://192.168.1.2:8765", true) }
    }
    @Test fun explicitEmulatorOptInAndResourceOrigins() {
        val policy = ServerPolicy("http://10.0.2.2:8765", true)
        assertTrue(policy.sameOrigin("http://10.0.2.2:8765/api/tasks"))
        assertFalse(policy.trustedDocument("http://10.0.2.2:8765/api/tasks"))
        assertFalse(policy.sameOrigin("http://10.0.2.2:8766/api/tasks"))
        assertFalse(policy.sameOrigin("javascript:alert(1)"))
    }
}
