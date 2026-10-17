import Gio from 'gi://Gio';

import {IconProvider} from './icon-provider.js';

/* Native GNOME icons — always available, so this is the guaranteed
   fallback for every request. */
export class SystemIconProvider extends IconProvider {
    constructor() {
        super('system');
    }

    lookupSync(request) {
        if (request.app) {
            const gicon = request.app.get_icon?.() ?? request.app.get_app_info?.()?.get_icon?.();
            return {
                gicon: gicon ?? Gio.ThemedIcon.new('application-x-executable'),
                source: gicon ? 'system' : 'fallback',
            };
        }
        if (request.iconName)
            return {gicon: Gio.ThemedIcon.new(request.iconName), source: 'system'};
        return null;
    }
}
