package dev.abridge.android

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

internal object AppUpdates {
    private const val REPOSITORY = "https://github.com/xerrors/aBridge"
    private val versionPattern = Regex("(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})")
    private val client = OkHttpClient.Builder().followRedirects(false)
        .callTimeout(12, TimeUnit.SECONDS).build()

    data class Release(val version: String, val notes: String, val download: String)

    private fun versionCode(version: String): Int =
        versionPattern.matchEntire(version)?.groupValues?.let { parts ->
            parts[1].toInt() * 1000000 + parts[2].toInt() * 1000 + parts[3].toInt()
        } ?: error("版本格式无效")

    fun find(): Release? {
        val request = Request.Builder().url("https://api.github.com/repos/xerrors/aBridge/releases/latest")
            .header("Accept", "application/vnd.github+json").build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error("检查更新失败，请稍后重试")
            val body = response.body ?: error("更新源没有返回版本信息")
            val source = body.source()
            if (source.request(524289L)) error("版本信息超过大小限制")
            return select(JSONObject(source.readUtf8()), BuildConfig.VERSION_NAME)
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
