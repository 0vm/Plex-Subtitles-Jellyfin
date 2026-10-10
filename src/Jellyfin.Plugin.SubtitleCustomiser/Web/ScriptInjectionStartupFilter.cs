using System;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;

namespace Jellyfin.Plugin.SubtitleCustomiser.Web;

/// <summary>
/// Puts <see cref="ScriptInjectionMiddleware"/> at the front of the server pipeline.
/// </summary>
public class ScriptInjectionStartupFilter : IStartupFilter
{
    /// <inheritdoc />
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.UseMiddleware<ScriptInjectionMiddleware>();
            next(app);
        };
    }
}
