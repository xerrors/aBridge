package com.aihome.app

import java.net.URI
import java.util.Locale

/** Exact server origin, with a separate explicit local-development HTTP opt-in. */
class ServerPolicy(address: String, allowLocalHttp: Boolean) {
    val origin: String
    init {
        val uri = URI(address.trim())
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        val host = uri.host?.lowercase(Locale.ROOT)
        require(host != null && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
            (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") &&
            (uri.port == -1 || uri.port in 1..65535)) { "请输入完整的服务器 Origin（不含路径、凭据或查询参数）" }
        require(scheme == "https" || (scheme == "http" && allowLocalHttp &&
            host in setOf("localhost", "127.0.0.1", "[::1]", "10.0.2.2"))) {
            "服务器必须使用 HTTPS；本机调试 HTTP 需单独启用"
        }
        val port = if (uri.port == -1 || (scheme == "https" && uri.port == 443) || (scheme == "http" && uri.port == 80)) "" else ":${uri.port}"
        origin = "$scheme://$host$port"
    }
    val controllerUrl get() = "$origin/controller/"
    fun sameOrigin(url: String): Boolean = runCatching {
        val uri = URI(url)
        uri.rawUserInfo == null && ServerPolicy(URI(uri.scheme, null, uri.host, uri.port, null, null, null).toString(), true).origin == origin
    }.getOrDefault(false)
    fun trustedDocument(url: String): Boolean = runCatching {
        sameOrigin(url) && URI(url).rawPath in setOf("/controller", "/controller/")
    }.getOrDefault(false)
}
