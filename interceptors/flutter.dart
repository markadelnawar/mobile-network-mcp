/// mobile-network-mcp — Flutter interceptor (Dio)
///
/// Add to your Dio instance in debug mode:
///   if (kDebugMode) {
///     dio.interceptors.add(NetworkMcpInterceptor());
///   }
///
/// Captures all Dio HTTP traffic and forwards to the MCP ingest API.
/// Adjust [ingestUrl] if using a different port.
///
/// For Android emulator: use http://10.0.2.2:7890/flows
/// For iOS simulator: use http://localhost:7890/flows

import 'dart:convert';
import 'dart:io';
import 'package:dio/dio.dart';

class NetworkMcpInterceptor extends Interceptor {
  final String ingestUrl;
  final HttpClient _client = HttpClient();

  NetworkMcpInterceptor({
    this.ingestUrl = 'http://localhost:7890/flows',
  });

  // Store request info to pair with response later
  final Map<int, _RequestMeta> _pending = {};

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    _pending[options.hashCode] = _RequestMeta(
      url: options.uri.toString(),
      method: options.method,
      headers: options.headers.map((k, v) => MapEntry(k.toLowerCase(), v.toString())),
      body: options.data != null ? jsonEncode(options.data) : null,
      startTime: DateTime.now(),
    );
    handler.next(options);
  }

  @override
  void onResponse(Response response, ResponseInterceptorHandler handler) {
    final meta = _pending.remove(response.requestOptions.hashCode);
    if (meta != null) {
      _send(meta, response.statusCode ?? 0, response.headers.map, response.data);
    }
    handler.next(response);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    final meta = _pending.remove(err.requestOptions.hashCode);
    if (meta != null) {
      _send(
        meta,
        err.response?.statusCode ?? 0,
        err.response?.headers.map ?? {},
        err.response?.data,
      );
    }
    handler.next(err);
  }

  void _send(
    _RequestMeta meta,
    int status,
    Map<String, List<String>> responseHeaders,
    dynamic responseData,
  ) async {
    try {
      final duration = DateTime.now().difference(meta.startTime).inMilliseconds;

      // Flatten response headers
      final flatHeaders = <String, String>{};
      responseHeaders.forEach((key, values) {
        flatHeaders[key.toLowerCase()] = values.join(', ');
      });

      String? bodyStr;
      if (responseData is String) {
        bodyStr = responseData;
      } else if (responseData != null) {
        bodyStr = jsonEncode(responseData);
      }

      final flow = {
        'request': {
          'url': meta.url,
          'method': meta.method,
          'headers': meta.headers,
          if (meta.body != null) 'body': meta.body,
        },
        'response': {
          'status': status,
          'statusText': '',
          'headers': flatHeaders,
          if (bodyStr != null) 'body': bodyStr,
        },
        'duration': duration,
      };

      final uri = Uri.parse(ingestUrl);
      final request = await _client.postUrl(uri);
      request.headers.set('Content-Type', 'application/json');
      request.write(jsonEncode(flow));
      final resp = await request.close();
      await resp.drain();
    } catch (_) {
      // Silently ignore — MCP server may not be running
    }
  }
}

class _RequestMeta {
  final String url;
  final String method;
  final Map<String, String> headers;
  final String? body;
  final DateTime startTime;

  _RequestMeta({
    required this.url,
    required this.method,
    required this.headers,
    this.body,
    required this.startTime,
  });
}
