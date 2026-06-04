/**
 * mobile-network-mcp — Android interceptor (OkHttp)
 *
 * Add to your OkHttpClient in debug builds:
 *   if (BuildConfig.DEBUG) {
 *       client.addInterceptor(NetworkMcpInterceptor())
 *   }
 *
 * Captures all OkHttp traffic and forwards to the MCP ingest API.
 * Adjust `INGEST_URL` below if using a different port.
 *
 * For emulator: use 10.0.2.2 instead of localhost.
 */

package com.example.debug // change to your package

import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

class NetworkMcpInterceptor(
    private val ingestUrl: String = "http://10.0.2.2:7890/flows"
) : Interceptor {

    private val ingestClient = OkHttpClient.Builder()
        .build()

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val startTime = System.currentTimeMillis()

        val response = chain.proceed(request)

        val duration = System.currentTimeMillis() - startTime

        // Read body without consuming it
        val responseBody = response.peekBody(1024 * 1024) // 1MB max
        val bodyString = responseBody.string()

        sendToIngest(request, response, bodyString, duration)

        return response
    }

    private fun sendToIngest(
        request: Request,
        response: Response,
        responseBody: String,
        duration: Long,
    ) {
        try {
            val requestHeaders = JSONObject()
            request.headers.forEach { (name, value) ->
                requestHeaders.put(name.lowercase(), value)
            }

            val responseHeaders = JSONObject()
            response.headers.forEach { (name, value) ->
                responseHeaders.put(name.lowercase(), value)
            }

            // Read request body if present
            val requestBodyStr = request.body?.let { body ->
                val buffer = okio.Buffer()
                body.writeTo(buffer)
                buffer.readUtf8()
            }

            val flow = JSONObject().apply {
                put("request", JSONObject().apply {
                    put("url", request.url.toString())
                    put("method", request.method)
                    put("headers", requestHeaders)
                    if (requestBodyStr != null) put("body", requestBodyStr)
                })
                put("response", JSONObject().apply {
                    put("status", response.code)
                    put("statusText", response.message)
                    put("headers", responseHeaders)
                    put("body", responseBody)
                })
                put("duration", duration)
            }

            val ingestRequest = Request.Builder()
                .url(ingestUrl)
                .post(flow.toString().toRequestBody("application/json".toMediaType()))
                .build()

            ingestClient.newCall(ingestRequest).enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {}
                override fun onResponse(call: Call, response: Response) { response.close() }
            })
        } catch (_: Exception) {
            // Silently ignore — MCP server may not be running
        }
    }
}
