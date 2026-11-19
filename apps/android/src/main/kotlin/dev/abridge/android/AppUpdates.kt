package dev.abridge.android

import java.net.URI
import javax.net.ssl.HttpsURLConnection
import java.io.ByteArrayOutputStream
import org.json.JSONObject

internal object AppUpdates {
    private const val REPOSITORY = "https://github.com/xerrors/aBridge"
    private val versionPattern = Regex("(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})")
    data class Release(val version: String, val notes: String, val download: String)

    private fun versionCode(version: String): Int =
        versionPattern.matchEntire(version)?.groupValues?.let { parts ->
            parts[1].toInt() * 1000000 + parts[2].toInt() * 1000 + parts[3].toInt()
        } ?: error("版本格式无效")

    fun find(): Release? {
        val conn = URI("https://api.github.com/repos/xerrors/aBridge/releases/latest").toURL().openConnection() as HttpsURLConnection
        conn.instanceFollowRedirects = false
        conn.connectTimeout = 6000
        conn.readTimeout = 6000
        conn.setRequestProperty("Accept", "application/vnd.github+json")
        try {
            if (conn.responseCode != 200) error("检查更新失败，请稍后重试")
            val data = ByteArrayOutputStream()
            conn.inputStream.use { stream ->
                val chunk = ByteArray(8192)
                while (true) {
                    val size = stream.read(chunk)
                    if (size < 0) break
                    if (data.size() + size > 524288) error("版本信息超过大小限制")
                    data.write(chunk, 0, size)
                }
            }
            return select(JSONObject(data.toString("UTF-8")), BuildConfig.VERSION_NAME)
        } finally {
            conn.disconnect()
        }
    }

    fun select(release: JSONObject, current: String): Release? {
        require(release.opt("draft") == false && release.opt("prerelease") == false)
        val tag = release.getString("tag_name")
        require(tag.startsWith("v"))
        val version = tag.drop(1)
        if (versionCode(version) <= versionCode(current)) return null
        val name = "aBridge-$version-android.apk"
        val download = "$REPOSITORY/releases/download/$tag/$name"
        val asset = release.getJSONArray("assets").values().filterIsInstance<JSONObject>()
            .singleOrNull { it.optString("name") == name }
            ?: error("这个版本还没有发布 Android 安装包")
        require(asset.optString("browser_download_url") == download)
        require(asset.optLong("size") in 1..500000)
        return Release(version, "$REPOSITORY/releases/tag/$tag", download)
    }
}
