# @06line/sdk

06 Line in the browser: place and answer calls on your 06 Line lines, with the microphone and speaker of your choice,
over WebRTC. It handles the plumbing (ephemeral key, session, audio devices, volumes) so a softphone is a few lines
of code.

**Status: in development.** For now the package only exports the types of the session events. Until the first
release, follow the [calls guide](https://docs.06line.com/docs/calls) to use the API directly.

```sh
npm install @06line/sdk
```

SMS are not part of the SDK: send them from your server with the REST API.

## Release

Publish a GitHub release (`v1.2.3`): the workflow builds the package and publishes it to npmjs.com with the version of
the tag. It needs an `NPM_TOKEN` secret that can publish to the `@06line` scope.

## License

MIT
