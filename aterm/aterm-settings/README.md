# Aterm Settings Plugin

* tabbed settings interface

Using the API:

```ts
import { SettingsTabProvider } from 'aterm-settings'
```

Exporting your subclasses:

```ts
@NgModule({
  ...
  providers: [
    ...
    { provide: SettingsTabProvider, useClass: MySettingsTab, multi: true },
    ...
  ]
})
```
