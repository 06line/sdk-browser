# @06line/sdk-browser

06 Line in the browser: place and answer calls on your 06 Line lines, with the microphone and speaker of your choice,
over WebRTC. It handles the plumbing (ephemeral key, session, audio devices, volumes) so a softphone is a few lines
of code.

Guide: [Call with the SDK](https://docs.06line.com/docs/call-with-sdk). Reference:
[docs.06line.com/docs/reference/sdk](https://docs.06line.com/docs/reference/sdk). A complete example:
[06line/example-softphone](https://github.com/06line/example-softphone). Without the SDK, from any platform:
[Call with the API](https://docs.06line.com/docs/call-with-api).

```sh
npm install @06line/sdk-browser
```

SMS are not part of the SDK: send them from your server with the REST API.

## Release

Publish a GitHub release (`v1.2.3`): the workflow builds the package and publishes it to npmjs.com with the version of
the tag. It needs an `NPM_TOKEN` secret that can publish to the `@06line` scope.

## License

MIT
