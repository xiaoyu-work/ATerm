import { ConfigProvider } from 'aterm-core'

/** @hidden */
export class WebConfigProvider extends ConfigProvider {
    defaults = {
        web: {
            preventAccidentalTabClosure: false,
        },
    }
}
