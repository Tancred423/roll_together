
---

## Fork Changes

This project has been enhanced with stability improvements to address random disconnections and sync fragility issues:

### Improvements:
- **Automatic Reconnection Logic**: Implemented exponential backoff reconnection with up to 5 attempts
- **Connection State Management**: Proper connection state tracking (disconnected, connecting, connected, reconnecting)
- **Heartbeat Monitoring**: Client-side heartbeat every 30 seconds to keep connections alive
- **Connection Timeout Handling**: 10-second connection timeout with automatic retry
- **Error Recovery**: Comprehensive error handling for connection failures with user notification
- **Socket Cleanup**: Complete cleanup of event listeners and timers on disconnect
- **Connection Validation**: Check socket connection status before sending messages
- **Race Condition Prevention**: Better handling of concurrent connection attempts

These improvements make the extension much more resilient to network issues and provide automatic recovery from temporary connection problems while maintaining room state and video progress synchronization.
Please note that the backend project had to be changed as well, so you cannot just use this extension with the original server by samuraiexx.

Backend repo with improvements: https://github.com/Tancred423/roll_together_backend

Original README below.

---

# Roll Together

Roll Together is an extension for Google Chrome. It synchronizes Crunchyroll Videos that are being played at multiple computers.

## How to use it
You can download it from Chrome Store using the following link [https://chrome.google.com/webstore/detail/ilpfeljgdikoabaclkjgkbeegeoijfca](https://chrome.google.com/webstore/detail/ilpfeljgdikoabaclkjgkbeegeoijfca). If you want to add this extension from the source code, you can download this repo and follow the instructions below.

1. Open the Extension Management page by navigating to chrome://extensions.
    - The Extension Management page can also be opened by clicking on the Chrome menu, hovering over More Tools then select Extensions.
2. Enable Developer Mode by clicking the toggle switch next to Developer mode.
3. Click the LOAD UNPACKED button and select the extension directory.

![](https://developer.chrome.com/static/images/get_started/load_extension.png)

Instructions from https://developer.chrome.com/extensions/getstarted
## TODO
- [x] Customizable Palette
- [x] Improve Logo/Name
- [x] Improve structure to allow more than one tab at the same time
- [ ] Firefox Browser Support
- [ ] Work with autoplay
- [ ] Create a Website

## Related Repos
Backend repo: https://github.com/samuraiexx/roll_together_backend
