import { ConfigProvider } from 'aterm-core'

/** @hidden */
export class ClickableLinksConfigProvider extends ConfigProvider {
    defaults = {
        clickableLinks: {
            modifier: null,
        },
    }

    platformDefaults = { }
}
