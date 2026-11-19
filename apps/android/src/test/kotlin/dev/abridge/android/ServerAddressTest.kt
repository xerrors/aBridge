package dev.abridge.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerAddressTest {
    @Test fun permitsHttpsWithoutCleartextConsent() {
        assertEquals("https://bridge.example.com", approvedServerAddress("https://bridge.example.com/", null))
        assertNull(approvedServerAddress("https://user@bridge.example.com", null))
    }

    @Test fun requiresConsentForTheExactHttpAddress() {
        val address = "http://10.42.0.203:18765"
        assertNull(approvedServerAddress(address, null))
        assertEquals(address, approvedServerAddress("$address/", address))
        assertNull(approvedServerAddress("http://10.42.0.203:18766", address))
        assertNull(approvedServerAddress("$address/another", address))
    }

    @Test fun onlyDebugKeepsPreviouslySavedLoopbackBindingsWithoutConsent() {
        val address = "http://127.0.0.1:62437"
        assertEquals(address, approvedServerAddress(address, null, debug = true))
        assertNull(approvedServerAddress(address, null, debug = false))
    }
}
