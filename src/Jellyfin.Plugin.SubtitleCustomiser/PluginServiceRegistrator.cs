using Jellyfin.Plugin.SubtitleCustomiser.Web;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.SubtitleCustomiser;

/// <summary>
/// Registers the middleware that adds the client script to the web client's index page.
/// </summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddTransient<IStartupFilter, ScriptInjectionStartupFilter>();
    }
}
