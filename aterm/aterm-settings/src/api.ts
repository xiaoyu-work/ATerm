/**
 * Extend to add your own settings tabs
 */
export abstract class SettingsTabProvider {
    id: string
    icon: string
    title: string
    weight = 0

    getComponentType (): any {
        return null
    }
}
