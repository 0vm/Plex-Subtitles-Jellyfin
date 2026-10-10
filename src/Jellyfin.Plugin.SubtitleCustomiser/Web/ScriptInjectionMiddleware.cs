using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.SubtitleCustomiser.Web;

/// <summary>
/// Adds the Plex Subtitles Jellyfin script tag to the web client's index.html as it is served.
/// Nothing on disk is modified, so it works with a read-only web folder (Docker, TrueNAS).
/// </summary>
public class ScriptInjectionMiddleware
{
    /// <summary>
    /// Attribute value that marks the injected tag, so the page is never injected twice.
    /// </summary>
    public const string Marker = "plugin=\"SubtitleCustomiser\"";

    private readonly RequestDelegate _next;
    private readonly ILogger<ScriptInjectionMiddleware> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="ScriptInjectionMiddleware"/> class.
    /// </summary>
    /// <param name="next">The next delegate in the pipeline.</param>
    /// <param name="logger">Logger.</param>
    public ScriptInjectionMiddleware(RequestDelegate next, ILogger<ScriptInjectionMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    /// <summary>
    /// Handles a request.
    /// </summary>
    /// <param name="context">The HTTP context.</param>
    /// <returns>A task.</returns>
    public async Task InvokeAsync(HttpContext context)
    {
        var plugin = Plugin.Instance;
        if (plugin is null || !plugin.Configuration.Enabled || !IsIndexRequest(context.Request))
        {
            await _next(context).ConfigureAwait(false);
            return;
        }

        // Ask for the plain, full document so it can be edited.
        var requestHeaders = context.Request.Headers;
        requestHeaders.Remove(HeaderNames.AcceptEncoding);
        requestHeaders.Remove(HeaderNames.IfNoneMatch);
        requestHeaders.Remove(HeaderNames.IfModifiedSince);
        requestHeaders.Remove(HeaderNames.Range);

        var originalBody = context.Response.Body;
        await using var buffer = new MemoryStream();
        context.Response.Body = buffer;
        try
        {
            await _next(context).ConfigureAwait(false);
        }
        finally
        {
            context.Response.Body = originalBody;
        }

        buffer.Position = 0;
        var response = context.Response;
        var isHtml = response.StatusCode == StatusCodes.Status200OK
            && (response.ContentType?.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) ?? false)
            && string.IsNullOrEmpty(response.Headers.ContentEncoding);

        if (!isHtml || response.HasStarted)
        {
            if (!response.HasStarted)
            {
                response.ContentLength = buffer.Length;
            }

            await buffer.CopyToAsync(originalBody, context.RequestAborted).ConfigureAwait(false);
            return;
        }

        string html;
        using (var reader = new StreamReader(buffer, Encoding.UTF8, true, 4096, leaveOpen: true))
        {
            html = await reader.ReadToEndAsync(context.RequestAborted).ConfigureAwait(false);
        }

        if (!html.Contains(Marker, StringComparison.Ordinal))
        {
            html = Inject(html, plugin.ScriptVersion);
        }

        var bytes = Encoding.UTF8.GetBytes(html);
        response.Headers.Remove(HeaderNames.ETag);
        response.Headers.Remove(HeaderNames.LastModified);
        response.Headers.Remove(HeaderNames.AcceptRanges);
        response.Headers.CacheControl = "no-cache";
        response.ContentLength = bytes.Length;
        await originalBody.WriteAsync(bytes, context.RequestAborted).ConfigureAwait(false);
    }

    /// <summary>
    /// Adds the script tag before the closing body tag.
    /// </summary>
    /// <param name="html">The page.</param>
    /// <param name="version">Cache-busting version string.</param>
    /// <returns>The page with the script tag.</returns>
    public static string Inject(string html, string version)
    {
        var tag = "<script " + Marker + " version=\"" + version + "\" src=\"../SubtitleCustomiser/ClientScript?v="
            + Uri.EscapeDataString(version) + "\" defer></script>";
        var index = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        return index >= 0 ? html.Insert(index, tag + "\n") : html + tag;
    }

    private static bool IsIndexRequest(HttpRequest request)
    {
        if (!HttpMethods.IsGet(request.Method))
        {
            return false;
        }

        var path = request.Path.Value;
        if (string.IsNullOrEmpty(path))
        {
            return false;
        }

        return path.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("/web/", StringComparison.OrdinalIgnoreCase);
    }
}
