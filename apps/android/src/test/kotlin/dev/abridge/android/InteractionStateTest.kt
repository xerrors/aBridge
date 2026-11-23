package dev.abridge.android

import org.junit.Assert.assertEquals
import org.junit.Test

class InteractionStateTest {
    @Test
    fun screenOffAndLockAreDistinctAndReadyRequiresBothConditions() {
        assertEquals(InteractionState.ScreenOff, InteractionState.from(false, false))
        assertEquals(InteractionState.ScreenOff, InteractionState.from(false, true))
        assertEquals(InteractionState.Locked, InteractionState.from(true, true))
        assertEquals(InteractionState.Ready, InteractionState.from(true, false))
        assertEquals("screen_off", InteractionState.ScreenOff.refusal)
        assertEquals("device_locked", InteractionState.Locked.refusal)
    }
}
