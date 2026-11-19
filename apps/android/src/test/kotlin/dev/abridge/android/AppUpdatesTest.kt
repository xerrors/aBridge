package dev.abridge.android

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class AppUpdatesTest {
    private val apk = "aBridge-0.4.20-android.apk"
    private val officialUrl = "https://github.com/xerrors/aBridge/releases/download/v0.4.20/$apk"

    private fun release(url: String = officialUrl, size: Int = 480000): JSONObject =
        JSONObject().put("draft", false).put("prerelease", false).put("tag_name", "v0.4.20")
            .put("assets", JSONArray().put(JSONObject().put("name", apk)
                .put("browser_download_url", url).put("size", size)))

    @Test fun selectsOfficialNewerApk() {
        val update = AppUpdates.select(release(), "0.4.19")
        assertEquals("0.4.20", update?.version)
        assertEquals(officialUrl, update?.download)
        assertNull(AppUpdates.select(release(), "0.4.20"))
        assertNull(AppUpdates.select(release(), "0.4.100"))
    }

    @Test fun rejectsInvalidReleaseAssets() {
        assertThrows(IllegalArgumentException::class.java) {
            AppUpdates.select(release("https://example.org/$apk"), "0.4.19")
        }
        assertThrows(IllegalArgumentException::class.java) {
            AppUpdates.select(release(size = 500001), "0.4.19")
        }
        assertThrows(IllegalArgumentException::class.java) {
            AppUpdates.select(release().put("prerelease", true), "0.4.19")
        }
        assertThrows(IllegalStateException::class.java) {
            AppUpdates.select(release().put("assets", JSONArray()), "0.4.19")
        }
    }
}
