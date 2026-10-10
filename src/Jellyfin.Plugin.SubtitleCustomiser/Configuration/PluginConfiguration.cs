using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.SubtitleCustomiser.Configuration;

/// <summary>
/// Server-wide settings. Users override the look from the player panel; these are the starting values.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Gets or sets a value indicating whether the client script is injected into the web client.
    /// </summary>
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// Gets or sets the default subtitle colour (white, yellow, green, cyan, blue, magenta, red, grey, black).
    /// </summary>
    public string DefaultColour { get; set; } = "white";

    /// <summary>
    /// Gets or sets the default subtitle size (tiny, small, normal, large, huge).
    /// </summary>
    public string DefaultSize { get; set; } = "normal";

    /// <summary>
    /// Gets or sets the default subtitle position (bottom, raised, middle, top).
    /// </summary>
    public string DefaultPosition { get; set; } = "bottom";

    /// <summary>
    /// Gets or sets the default subtitle style (shadow, outline, box, plain).
    /// </summary>
    public string DefaultStyle { get; set; } = "shadow";

    /// <summary>
    /// Gets or sets a value indicating whether bottom subtitles move up while the player controls are showing.
    /// </summary>
    public bool LiftAboveControls { get; set; } = true;
}
