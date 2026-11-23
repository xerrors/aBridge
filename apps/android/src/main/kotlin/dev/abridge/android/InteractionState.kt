package dev.abridge.android

import android.app.KeyguardManager
import android.content.Context
import android.os.PowerManager

internal enum class InteractionState(val wire: String, val refusal: String) {
    Ready("ready", ""), ScreenOff("screen_off", "screen_off"), Locked("locked", "device_locked");

    companion object {
        fun from(interactive: Boolean, locked: Boolean): InteractionState = when {
            !interactive -> ScreenOff
            locked -> Locked
            else -> Ready
        }
    }
}

internal fun Context.interactionState(): InteractionState = InteractionState.from(
    getSystemService(PowerManager::class.java).isInteractive,
    getSystemService(KeyguardManager::class.java).isKeyguardLocked,
)
