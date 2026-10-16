import { useEffect, useState } from "react";

/**
 * Routing by URL hash: #/send, #/reserves. Enough for a handful of pages, and
 * it needs neither a dependency nor server support for deep links.
 */
export function useRoute(): string {
    const read = () => window.location.hash.replace(/^#/, "") || "/";
    const [route, setRoute] = useState(read);
    useEffect(() => {
        const onChange = () => setRoute(read());
        window.addEventListener("hashchange", onChange);
        return () => window.removeEventListener("hashchange", onChange);
    }, []);
    return route;
}

export const navigate = (route: string) => {
    window.location.hash = route;
};
