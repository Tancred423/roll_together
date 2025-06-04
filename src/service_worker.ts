import io from "socket.io-client";
import _ from "lodash";

import { log, getParameterByName, setIconColor } from "./common";
import { Message, MessageTypes, PortName, States, TabInfo } from "./types";

declare const process: { env: { [key: string]: string | undefined } };
declare const self: ServiceWorkerGlobalScope;

interface ExtendedTabInfo extends TabInfo {
  reconnectTimer?: NodeJS.Timeout;
  heartbeatInterval?: NodeJS.Timeout;
  lastHeartbeat?: Date;
}

const tabsInfo: { [index: number]: ExtendedTabInfo | undefined } = {};
const serverUrl = process.env.SYNC_SERVER!;

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_BASE = 1000;
const HEARTBEAT_INTERVAL = 30000;
const CONNECTION_TIMEOUT = 10000;

let popupPort: chrome.runtime.Port | undefined = undefined;

function handleContentScriptConnection(port: chrome.runtime.Port): void {
  const tabId = port.sender?.tab?.id!;
  const url = port.sender?.tab?.url!;

  if (_.isNil(tabsInfo[tabId])) {
    tabsInfo[tabId] = { 
      port, 
      tabId, 
      sentConnectionRequest: false,
      reconnectAttempts: 0,
      connectionState: 'disconnected'
    };
  }

  const urlRoomId: string | null = getParameterByName(url, "rollTogetherRoom");
  if (!_.isNil(urlRoomId)) {
    sendConnectionRequestToContentScript(tabId);
  } else {
    chrome.action.enable(tabId);
  }
}

function handleContentScriptDisconnection(port: chrome.runtime.Port): void {
  const tabId = port.sender?.tab?.id!;
  chrome.action.disable(tabId);
  disconnectWebsocket(tabId);
  delete tabsInfo[tabId];
}

function tryUpdatePopup(roomId: string | undefined = undefined): void {
  log("Trying to update popup", roomId);
  popupPort?.postMessage({
    type: MessageTypes.SW2PU_SEND_ROOM_ID,
    roomId: roomId,
  });
}

function clearReconnectTimer(tabId: number): void {
  const tabInfo = tabsInfo[tabId];
  if (tabInfo?.reconnectTimer) {
    clearTimeout(tabInfo.reconnectTimer);
    delete tabInfo.reconnectTimer;
  }
}

function clearHeartbeatInterval(tabId: number): void {
  const tabInfo = tabsInfo[tabId];
  if (tabInfo?.heartbeatInterval) {
    clearInterval(tabInfo.heartbeatInterval);
    delete tabInfo.heartbeatInterval;
  }
}

function startHeartbeat(tabId: number): void {
  const tabInfo = tabsInfo[tabId];
  if (!tabInfo?.socket) return;

  clearHeartbeatInterval(tabId);
  
  tabInfo.heartbeatInterval = setInterval(() => {
    if (tabInfo.socket?.connected) {
      tabInfo.socket.emit('heartbeat');
      tabInfo.lastHeartbeat = new Date();
      log(`Heartbeat sent for tab ${tabId}`);
    }
  }, HEARTBEAT_INTERVAL);
}

function disconnectWebsocket(tabId: number): void {
  log("Disconnecting websocket", tabId);
  const tabInfo = tabsInfo[tabId];
  if (!tabInfo) {
    log(`No tab info found for tab ${tabId}`);
    return;
  }

  clearReconnectTimer(tabId);
  clearHeartbeatInterval(tabId);

  const { socket, roomId } = tabInfo;
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    delete tabInfo.socket;
  }
  if (roomId) {
    delete tabInfo.roomId;
  }

  tabInfo.connectionState = 'disconnected';
  tabInfo.reconnectAttempts = 0;
  tryUpdatePopup();
}

function sendConnectionErrorToContentScript(tabId: number, error: string): void {
  log("Sending connection error to contentScript", { tabId, error });

  const message: Message = {
    type: MessageTypes.SW2CS_CONNECTION_ERROR,
    error,
  };
  tabsInfo[tabId]?.port.postMessage(message);
}

function scheduleReconnect(tabId: number, urlRoomId: string | null, videoProgress: number, videoState: States): void {
  const tabInfo = tabsInfo[tabId];
  if (!tabInfo) return;

  tabInfo.reconnectAttempts = (tabInfo.reconnectAttempts || 0) + 1;

  if (tabInfo.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    log(`Max reconnection attempts reached for tab ${tabId}`);
    tabInfo.connectionState = 'disconnected';
    sendConnectionErrorToContentScript(tabId, `Failed to connect after ${MAX_RECONNECT_ATTEMPTS} attempts`);
    return;
  }

  const delay = RECONNECT_DELAY_BASE * Math.pow(2, tabInfo.reconnectAttempts - 1);
  log(`Scheduling reconnection attempt ${tabInfo.reconnectAttempts} for tab ${tabId} in ${delay}ms`);

  tabInfo.connectionState = 'reconnecting';
  tabInfo.reconnectTimer = setTimeout(() => {
    log(`Attempting reconnection ${tabInfo.reconnectAttempts} for tab ${tabId}`);
    connectWebsocket(tabId, videoProgress, videoState, urlRoomId, true);
  }, delay);
}

function handlePopupMessage(message: Message, port: chrome.runtime.Port): void {
  switch (message.type) {
    case MessageTypes.PU2SW_CREATE_ROOM:
      sendConnectionRequestToContentScript(message.tabId);
      break;
    case MessageTypes.PU2SW_DISCONNECT_ROOM:
      disconnectWebsocket(message.tabId);
      break;
    case MessageTypes.PU2SW_REQUEST_ROOM_ID:
      tryUpdatePopup(tabsInfo[message.tabId]?.roomId);
      break;
    default:
      throw "Invalid PopupMessageType " + message.type;
  }
}

function handleContentScriptMessage(
  message: Message,
  port: chrome.runtime.Port
): void {
  const senderUrl: string = port.sender?.tab?.url!;
  const tabId = port.sender?.tab?.id!;
  log("Received message from contentScript", { tabId, message });

  switch (message.type) {
    case MessageTypes.CS2SW_HEART_BEAT:
      break;
    case MessageTypes.CS2SW_ROOM_CONNECTION:
      connectWebsocket(
        tabId,
        message.currentProgress,
        message.state,
        getParameterByName(senderUrl)
      );
      break;
    case MessageTypes.CS2SW_LOCAL_UPDATE:
      const tabInfo = tabsInfo[tabId];
      if (tabInfo?.socket?.connected) {
        tabInfo.socket.emit("update", message.state, message.currentProgress);
      } else {
        log(`Socket not connected for tab ${tabId}, attempting to reconnect`);
        connectWebsocket(tabId, message.currentProgress, message.state, tabInfo?.roomId || null);
      }
      break;
    default:
      throw "Invalid ContentScriptMessageType " + message.type;
  }
}

function sendUpdateToContentScript(
  tabId: number,
  roomState: States,
  roomProgress: number
): void {
  log("Sending update to contentScript", { tabId, roomState, roomProgress });

  const message: Message = {
    type: MessageTypes.SW2CS_REMOTE_UPDATE,
    roomState,
    roomProgress,
  };
  tabsInfo[tabId]?.port.postMessage(message);
}

function sendConnectionRequestToContentScript(tabId: number): void {
  const tabInfo = tabsInfo[tabId];
  log({ tabsInfo, tabInfo, tabId });
  const port = tabInfo!.port!;
  const tab = port.sender!.tab!;

  if (tabInfo == undefined) {
    log(`No tab info found for tab ${tabId}`);
    return;
  }

  if (tabInfo.sentConnectionRequest && tabInfo.connectionState === 'connecting') {
    log("Connection request already sent to contentScript", { tab });
    return;
  }
  tabInfo.sentConnectionRequest = true;

  if (tabInfo.socket) {
    if (getParameterByName(tab.url!, "rollTogetherRoom") === tabInfo.roomId) {
      return;
    }
    disconnectWebsocket(tabId);
  }

  log("Sending connection request to contentScript", { tab });

  const message: Message = {
    type: MessageTypes.SW2CS_ROOM_CONNECTION,
  };
  port.postMessage(message);
}

function connectWebsocket(
  tabId: number,
  videoProgress: number,
  videoState: States,
  urlRoomId: string | null,
  isReconnect: boolean = false
) {
  log("Connecting websocket", {
    tabId,
    videoProgress,
    videoState,
    urlRoomId,
    isReconnect,
  });
  const tabInfo = tabsInfo[tabId];
  if (!tabInfo) {
    log(`No tab info found for tab ${tabId}`);
    return;
  }

  if (tabInfo.socket?.connected && !isReconnect) {
    log(`Socket is already connected for tab ${tabId}`);
    return;
  }

  if (tabInfo.connectionState === 'connecting') {
    log(`Connection already in progress for tab ${tabId}`);
    return;
  }

  tabInfo.connectionState = 'connecting';
  clearReconnectTimer(tabId);

  let query: string = `videoProgress=${Math.round(
    videoProgress
  )}&videoState=${videoState}${urlRoomId ? `&room=${urlRoomId}` : ""}`;

  const socketOptions = {
    query,
    transports: ["websocket", "polling"],
    timeout: CONNECTION_TIMEOUT,
    reconnection: false,
    forceNew: true,
  };

  tabInfo.socket = io(serverUrl, socketOptions);

  const socket = tabInfo.socket;

  const connectionTimeout = setTimeout(() => {
    if (tabInfo.connectionState === 'connecting') {
      log(`Connection timeout for tab ${tabId}`);
      socket.disconnect();
      scheduleReconnect(tabId, urlRoomId, videoProgress, videoState);
    }
  }, CONNECTION_TIMEOUT);

  socket.on('connect', () => {
    clearTimeout(connectionTimeout);
    log(`Socket connected for tab ${tabId}`);
    tabInfo.connectionState = 'connected';
    tabInfo.reconnectAttempts = 0;
    startHeartbeat(tabId);
  });

  socket.on('connect_error', (error: Error) => {
    clearTimeout(connectionTimeout);
    log(`Connection error for tab ${tabId}:`, error);
    tabInfo.connectionState = 'disconnected';
    scheduleReconnect(tabId, urlRoomId, videoProgress, videoState);
  });

  socket.on('disconnect', (reason: string) => {
    clearTimeout(connectionTimeout);
    clearHeartbeatInterval(tabId);
    log(`Socket disconnected for tab ${tabId}. Reason: ${reason}`);
    
    tabInfo.connectionState = 'disconnected';
    
    if (reason === 'io server disconnect' || reason === 'io client disconnect') {
      log(`Manual disconnect for tab ${tabId}, not attempting to reconnect`);
      return;
    }
    
    scheduleReconnect(tabId, urlRoomId, videoProgress, videoState);
  });

  socket.on('error', (error: Error) => {
    log(`Socket error for tab ${tabId}:`, error);
  });

  socket.on(
    "join",
    (receivedRoomId: string, roomState: States, roomProgress: number): void => {
      tabInfo.roomId = receivedRoomId;
      log("Successfully joined a room", {
        roomId: tabInfo.roomId,
        roomState,
        roomProgress,
        isReconnect,
      });
      tryUpdatePopup(tabInfo.roomId);
      chrome.action.enable(tabId);
      tabInfo.sentConnectionRequest = false;

      sendUpdateToContentScript(tabId, roomState, roomProgress);
    }
  );

  socket.on(
    "update",
    (id: string, roomState: States, roomProgress: number): void => {
      log("Received update Message from ", id, { roomState, roomProgress });
      sendUpdateToContentScript(tabId, roomState, roomProgress);
    }
  );

  socket.on(
    "reconnected",
    (roomId: string, roomState: States, roomProgress: number): void => {
      log("Received reconnected event", { roomId, roomState, roomProgress });
      sendUpdateToContentScript(tabId, roomState, roomProgress);
    }
  );
}

chrome.runtime.onConnect.addListener(function (port) {
  log("Port connected", port.name);
  switch (port.name) {
    case PortName.POPUP:
      popupPort = port;
      log("Popup connected");

      port.onDisconnect.addListener(() => {
        popupPort = undefined;
        log("Popup disconnected");
      });
      port.onMessage.addListener(handlePopupMessage);
      break;
    case PortName.CONTENT_SCRIPT:
      handleContentScriptConnection(port);
      log(`${port.name} connected`, port.sender?.tab?.id);

      port.onDisconnect.addListener(() => {
        handleContentScriptDisconnection(port);
        log(`${port.name} disconnected`, port.sender?.tab?.id);
      });

      port.onMessage.addListener(handleContentScriptMessage);
      break;
    default:
      throw "Invalid PortName " + port.name;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  const canvas = new OffscreenCanvas(128, 128);
  const ctx = canvas.getContext("2d")! as OffscreenCanvasRenderingContext2D;
  setIconColor(canvas, ctx);
});

chrome.action.disable();
self.addEventListener = _.noop;

log("Service Worker Loaded");
