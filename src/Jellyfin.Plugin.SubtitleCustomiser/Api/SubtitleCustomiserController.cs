using System.Net.Mime;
using Jellyfin.Plugin.SubtitleCustomiser.Configuration;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SubtitleCustomiser.Api;

/// <summary>
/// Serves the client script and the server defaults, and records client diagnostics.
/// </summary>
[ApiController]
[Route("SubtitleCustomiser")]
public class SubtitleCustomiserController : ControllerBase
{
    private const string ScriptResource = "Jellyfin.Plugin.SubtitleCustomiser.Web.subtitle-customiser.js";

    private readonly ILogger<SubtitleCustomiserController> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="SubtitleCustomiserController"/> class.
    /// </summary>
    /// <param name="logger">Logger.</param>
    public SubtitleCustomiserController(ILogger<SubtitleCustomiserController> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Gets the client script.
    /// </summary>
    /// <returns>The JavaScript file.</returns>
    [HttpGet("ClientScript")]
    [AllowAnonymous]
    [Produces("application/javascript")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult GetClientScript()
    {
        var stream = typeof(SubtitleCustomiserController).Assembly.GetManifestResourceStream(ScriptResource);
        if (stream is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "public, max-age=86400";
        return File(stream, "application/javascript; charset=utf-8");
    }

    /// <summary>
    /// Gets the server-wide defaults for the subtitle look.
    /// </summary>
    /// <returns>The defaults.</returns>
    [HttpGet("Defaults")]
    [AllowAnonymous]
    [Produces(MediaTypeNames.Application.Json)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<PluginConfiguration> GetDefaults()
    {
        return Plugin.Instance?.Configuration ?? new PluginConfiguration();
    }

    /// <summary>
    /// Records a short diagnostic message from a signed-in browser in the server log.
    /// </summary>
    /// <param name="entry">The message.</param>
    /// <returns>No content.</returns>
    [HttpPost("ClientLog")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public ActionResult PostClientLog([FromBody] ClientLogEntry entry)
    {
        var kind = Truncate(entry?.Kind, 40);
        var message = Truncate(entry?.Message, 2000);
        if (kind.StartsWith("fallback", System.StringComparison.Ordinal))
        {
            _logger.LogWarning("Plex Subtitles Jellyfin client {Kind}: {Message}", kind, message);
        }
        else
        {
            _logger.LogInformation("Plex Subtitles Jellyfin client {Kind}: {Message}", kind, message);
        }

        return NoContent();
    }

    private static string Truncate(string? value, int length)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        var clean = value.Replace('\r', ' ').Replace('\n', ' ');
        return clean.Length <= length ? clean : clean[..length];
    }
}

/// <summary>
/// A diagnostic message sent by the client script.
/// </summary>
public class ClientLogEntry
{
    /// <summary>
    /// Gets or sets the message kind.
    /// </summary>
    public string? Kind { get; set; }

    /// <summary>
    /// Gets or sets the message text.
    /// </summary>
    public string? Message { get; set; }
}
