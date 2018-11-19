/* @flow */
/* eslint-disable no-console */
import React, { Component } from "react";
import { View, SafeAreaView, Dimensions, StyleSheet } from "react-native";
import type { NavigationScreenProp } from "react-navigation";
import { from, of } from "rxjs";
import { mergeMap, delay, catchError, throwError } from "rxjs/operators";
import { translate, Trans } from "react-i18next";
import { CantOpenDevice } from "@ledgerhq/live-common/lib/errors";
import installMcu from "../../logic/hw/installMcu";
import installFinalFirmware from "../../logic/hw/installFinalFirmware";
import getDeviceInfo from "../../logic/hw/getDeviceInfo";
import { withDevice, withDevicePolling } from "../../logic/hw/deviceAccess";
import type { Firmware } from "../../types/manager";
import colors from "../../colors";
import DeviceNanoAction from "../../components/DeviceNanoAction";
import StepHeader from "../../components/StepHeader";
import { BulletItem } from "../../components/BulletList";
import Installing from "./Installing";

type Navigation = NavigationScreenProp<{
  params: {
    deviceId: string,
    latestFirmware: ?Firmware,
  },
}>;

type Props = {
  navigation: Navigation,
};

type State = {
  installing: boolean,
};

const ignoreDeviceDisconnectedError = catchError(
  e => (e instanceof CantOpenDevice ? of(null) : throwError(e)),
);

class FirmwareUpdateMCU extends Component<Props, State> {
  static navigationOptions = {
    headerLeft: null,
    headerTitle: (
      <StepHeader
        subtitle={<Trans i18nKey="FirmwareUpdate.title" />}
        title={<Trans i18nKey="FirmwareUpdateMCU.title" />}
      />
    ),
  };

  state = {
    installing: false,
  };

  sub: *;

  async componentDidMount() {
    const { navigation } = this.props;
    const deviceId = navigation.getParam("deviceId");

    const loop = () =>
      withDevicePolling(deviceId)(
        transport => from(getDeviceInfo(transport)),
        () => true, // accept all errors. we're waiting forever condition that make getDeviceInfo work
      ).pipe(
        mergeMap(deviceInfo => {
          console.log({ deviceInfo });

          if (!deviceInfo.isBootloader && !deviceInfo.isOSU) {
            // nothing to do, we're done
            return of(null);
          }

          // appropriate script to install
          const install = deviceInfo.isBootloader
            ? installMcu
            : installFinalFirmware;

          this.setState({ installing: true });
          return withDevice(deviceId)(install).pipe(
            delay(2000), // we're pausing 2s just for the device to "catch up". usually it reboots / switch mode
            ignoreDeviceDisconnectedError, // this can happen if withDevicePolling was still seeing the device but it was then interrupted by a device reboot
            mergeMap(loop), // loop again
          );
        }),
      );

    this.sub = loop().subscribe({
      complete: () => {
        navigation.navigate("FirmwareUpdateConfirmation", {
          ...navigation.state.params,
        });
      },
      error: error => {
        navigation.navigate("FirmwareUpdateFailure", {
          ...navigation.state.params,
          error,
        });
      },
    });
  }

  componentWillUnmount() {
    if (this.sub) this.sub.unsubscribe();
  }

  render() {
    const { installing } = this.state;
    const windowWidth = Dimensions.get("window").width;
    return (
      <SafeAreaView style={styles.root}>
        {installing ? (
          <Installing />
        ) : (
          <View style={styles.body}>
            <View style={styles.step}>
              <BulletItem
                index={0}
                value={<Trans i18nKey="FirmwareUpdateMCU.desc1" />}
              />
              <View style={styles.device}>
                <DeviceNanoAction width={1.2 * windowWidth} />
              </View>
            </View>

            <View style={styles.step}>
              <BulletItem
                index={1}
                value={<Trans i18nKey="FirmwareUpdateMCU.desc2" />}
              />
              <View style={styles.device}>
                <DeviceNanoAction powerAction width={1.2 * windowWidth} />
              </View>
            </View>
          </View>
        )}
      </SafeAreaView>
    );
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.white,
  },
  body: {
    padding: 20,
    flex: 1,
  },
  step: {
    flex: 1,
    justifyContent: "center",
    position: "relative",
  },
  device: {
    left: "10%",
    position: "relative",
  },
  description: {
    color: colors.smoke,
    fontSize: 14,
    marginVertical: 30,
  },
});

export default translate()(FirmwareUpdateMCU);
