import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches an error while rendering (instead of React unmounting the whole app, which leaves only the background):
 * shows it with "Try again" (renders the app again) and "Reload" (the page — after a hot update that changed the
 * main process or preload, the renderer may call what the old one lacked).
 */
export class ErrorBoundary extends Component<{ children: ReactNode; }, { error: Error | null; }>
{
    state = { error: null as Error | null };

    static getDerivedStateFromError(error: Error): { error: Error; }
    {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void
    {
        console.error('Render error', error, info.componentStack);
    }

    render(): ReactNode
    {
        const { error } = this.state;

        if (!error)
            return this.props.children;

        return (
            <div className="render-error">
                <h2>Something went wrong while drawing this page</h2>
                <pre>{String(error.stack ?? error)}</pre>
                <div className="actions">
                    <button onClick={() => this.setState({ error: null })}>Try again</button>
                    <button className="primary" onClick={() => location.reload()}>
                        Reload
                    </button>
                </div>
            </div>
        );
    }
}
