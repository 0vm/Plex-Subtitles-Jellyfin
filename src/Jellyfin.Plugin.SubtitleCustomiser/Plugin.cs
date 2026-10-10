using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.SubtitleCustomiser.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.SubtitleCustomiser;

/// <summary>
/// Plex Subtitles Jellyfin plugin entry point.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>
    /// The plugin id.
    /// </summary>
    public static readonly Guid PluginId = new("3c1f6a5e-8d2b-4f7a-9b61-5c2e7d9a4f18");

    /// <summary>
    /// Initializes a new instance of the <see cref="Plugin"/> class.
    /// </summary>
    /// <param name="applicationPaths">Instance of the <see cref="IApplicationPaths"/> interface.</param>
    /// <param name="xmlSerializer">Instance of the <see cref="IXmlSerializer"/> interface.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    /// <summary>
    /// Gets the current plugin instance.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public override string Name => "Plex Subtitles Jellyfin";

    /// <inheritdoc />
    public override Guid Id => PluginId;

    /// <inheritdoc />
    public override string Description => "Plex style subtitle panel for the web player: track, colour, position, size, style and offset from the CC button.";

    /// <summary>
    /// Gets a version string used to bust browser caches for the client script. It changes on every
    /// server start, and installing or updating a plugin always needs a restart.
    /// </summary>
    public string ScriptVersion { get; } = typeof(Plugin).Assembly.GetName().Version + "-"
        + DateTime.UtcNow.Ticks.ToString(CultureInfo.InvariantCulture);

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            new PluginPageInfo
            {
                Name = "SubtitleCustomiser",
                EmbeddedResourcePath = GetType().Namespace + ".Configuration.configPage.html"
            }
        };
    }
}
