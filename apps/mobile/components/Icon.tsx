import { View } from "react-native";
import { colors } from "../lib/theme";
export type IconName =
  "settings" | "menu" | "plus" | "back" | "send" | "stop" | "close" | "down" | "monitor" | "edit";
/** Small line icons rendered with native shapes: no emoji, font downloads or native dependencies. */
export function Icon({
  name,
  color = colors.text,
  size = 22,
}: {
  name: IconName;
  color?: string;
  size?: number;
}) {
  const line = {
    position: "absolute" as const,
    backgroundColor: color,
    borderRadius: 1,
    height: 2,
  };
  const stroke = (width: number, top: number, left: number, rotate = "0deg") => (
    <View style={{ ...line, width, top, left, transform: [{ rotate }] }} />
  );
  return (
    <View
      accessible={false}
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
    >
      <View style={{ width: 24, height: 24, transform: [{ scale: size / 24 }] }}>
        {name === "menu" ? (
          <>
            {stroke(18, 8, 3)}
            {stroke(12, 15, 3)}
          </>
        ) : name === "plus" ? (
          <>
            {stroke(16, 11, 4)}
            {stroke(16, 11, 4, "90deg")}
          </>
        ) : name === "close" ? (
          <>
            {stroke(16, 11, 4, "45deg")}
            {stroke(16, 11, 4, "-45deg")}
          </>
        ) : name === "stop" ? (
          <View
            style={{
              width: 12,
              height: 12,
              backgroundColor: color,
              borderRadius: 2,
              top: 6,
              left: 6,
            }}
          />
        ) : name === "send" ? (
          <>
            {stroke(16, 12, 4, "90deg")}
            {stroke(10, 7, 4, "-45deg")}
            {stroke(10, 7, 10, "45deg")}
          </>
        ) : name === "back" ? (
          <>
            {stroke(16, 11, 4)}
            {stroke(10, 8, 3, "-45deg")}
            {stroke(10, 15, 3, "45deg")}
          </>
        ) : name === "down" ? (
          <>
            {stroke(9, 12, 5, "45deg")}
            {stroke(9, 12, 10, "-45deg")}
          </>
        ) : name === "settings" ? (
          <>
            <View style={{position:'absolute',borderWidth:1.5,borderColor:color,borderRadius:7,width:14,height:14,top:5,left:5}}/>
            <View style={{position:'absolute',borderWidth:1.5,borderColor:color,borderRadius:3,width:5,height:5,top:9.5,left:9.5}}/>
            {stroke(4,2,10,'90deg')}{stroke(4,20,10,'90deg')}{stroke(4,11,1)}{stroke(4,11,19)}
          </>
        ) : name === "monitor" ? (
          <>
            <View
              style={{
                borderWidth: 1.5,
                borderColor: color,
                borderRadius: 3,
                width: 20,
                height: 14,
                top: 3,
                left: 2,
              }}
            />
            {stroke(8, 21, 8)}
            {stroke(5, 18, 9.5, "90deg")}
          </>
        ) : (
          <>
            <View
              style={{
                borderWidth: 1.5,
                borderColor: color,
                borderRadius: 4,
                width: 16,
                height: 16,
                top: 5,
                left: 3,
              }}
            />
            {stroke(14, 8, 9, "-45deg")}
          </>
        )}
      </View>
    </View>
  );
}
