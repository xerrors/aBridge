package dev.abridge.android

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

internal fun JSONArray.values(): List<Any> = List(length()) { get(it) }

internal class DeviceContract(context: Context) {
    private val data = JSONObject(context.assets.open("desktop-contract.json").bufferedReader().use { it.readText() })
    val protocol = data.getString("protocol")
    val version = data.getString("version")
    val limits = data.getJSONObject("limits")
    val androidTools = data.getJSONArray("androidTools").values().filterIsInstance<String>().toSet()
    private val capabilities = data.getJSONObject("toolCapabilities")
    private val schemas = data.getJSONObject("schemas")

    fun required(tool: String, arguments: JSONObject): Set<String> {
        val capability = capabilities.optString(tool)
        if (capability !in setOf("screen", "input", "files")) return emptySet()
        return if (tool == "computer_open" ||
            (tool == "computer_act" && (arguments.optBoolean("observe_after", true) || arguments.optBoolean("screenshot"))))
            setOf(capability, "screen") else setOf(capability)
    }

    fun validate(name: String, value: JSONObject): Boolean =
        schemas.optJSONObject(name)?.let { matches(it, value) } == true

    private fun rule(expr: JSONArray, value: Any): Boolean {
        fun property(): Any? {
            val key = expr.getString(1)
            return if (key.isEmpty()) value else (value as? JSONObject)?.opt(key)
        }
        return when (expr.getString(0)) {
            "and" -> (1 until expr.length()).all { rule(expr.getJSONArray(it), value) }
            "or" -> (1 until expr.length()).any { rule(expr.getJSONArray(it), value) }
            "not" -> !rule(expr.getJSONArray(1), value)
            "exists" -> property() != null
            "truthy" -> when (val field = property()) {
                null, JSONObject.NULL, false -> false
                is String -> field.isNotEmpty()
                is Number -> field.toDouble() != 0.0
                else -> true
            }
            "unique" -> value is JSONArray && value.values().toSet().size == value.length()
            "nonblank" -> value is String && value.isNotBlank()
            "noNul" -> value is String && '\u0000' !in value
            "unicode" -> value is String && Charsets.UTF_8.newEncoder().canEncode(value)
            "utf8Max" -> value is String && value.toByteArray(Charsets.UTF_8).size <= expr.getInt(1)
            else -> false
        }
    }

    private fun matches(schema: JSONObject, value: Any): Boolean {
        if (schema.optJSONArray("x-rule")?.let { !rule(it, value) } == true) return false
        val allowed = schema.optJSONArray("enum")
        if (allowed != null && value !in allowed.values()) return false
        if (schema.has("const") && schema.get("const") != value) return false
        for (key in listOf("oneOf", "anyOf", "allOf")) {
            val variants = schema.optJSONArray(key)?.values()?.filterIsInstance<JSONObject>() ?: continue
            val count = variants.count { matches(it, value) }
            if (key == "oneOf" && count != 1 || key == "anyOf" && count == 0 || key == "allOf" && count != variants.size)
                return false
        }
        return when (schema.optString("type")) {
            "object" -> {
                if (value !is JSONObject) return false
                val required = schema.optJSONArray("required")?.values().orEmpty()
                if (required.any { !value.has(it.toString()) }) return false
                val properties = schema.optJSONObject("properties")
                val additional = schema.opt("additionalProperties")
                value.keys().asSequence().all {
                    val field = properties?.optJSONObject(it)
                    when {
                        field != null -> matches(field, value.get(it))
                        additional is JSONObject -> matches(additional, value.get(it))
                        else -> additional != false
                    }
                }
            }
            "array" -> {
                if (value !is JSONArray || value.length() < schema.optInt("minItems", 0) ||
                    value.length() > schema.optInt("maxItems", Int.MAX_VALUE)) return false
                val items = schema.optJSONObject("items")
                items == null || value.values().all { matches(items, it) }
            }
            "integer", "number" -> {
                val n = (value as? Number)?.toDouble() ?: return false
                n.isFinite() &&
                    (schema.getString("type") != "integer" || n % 1 == 0.0) &&
                    n >= schema.optDouble("minimum", Double.NEGATIVE_INFINITY) &&
                    n <= schema.optDouble("maximum", Double.POSITIVE_INFINITY) &&
                    n > schema.optDouble("exclusiveMinimum", Double.NEGATIVE_INFINITY) &&
                    n < schema.optDouble("exclusiveMaximum", Double.POSITIVE_INFINITY)
            }
            "string" -> value is String && value.length >= schema.optInt("minLength", 0) &&
                value.length <= schema.optInt("maxLength", Int.MAX_VALUE) &&
                (!schema.has("pattern") || Regex(schema.getString("pattern")).containsMatchIn(value))
            "boolean" -> value is Boolean
            "null" -> value == JSONObject.NULL
            "" -> true
            else -> false
        }
    }
}
