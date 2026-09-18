// dsh-plugin-computer-use — native macOS helper.
//
// One dependency-free Objective-C executable that gives the DSH `computer` tool
// the two capabilities JavaScript cannot reach on its own:
//
//   probe   report displays, scaling and TCC permission state
//   pointer report the current cursor position, in global display points
//   act     read a normalised action batch as JSON on stdin
//
// Screenshots are *not* taken here: `CGDisplayCreateImage` is obsoleted from
// macOS 15 onward (ScreenCaptureKit replaced it), so capture goes through the
// system `screencapture` binary instead. That keeps this helper small, and it
// means capture keeps working on future releases without a rewrite. The
// JavaScript side reads the resulting PNG's IHDR for exact pixel dimensions.
//
// Objective-C (rather than Swift) is deliberate: it needs nothing beyond the
// Command Line Tools' C/Objective-C compiler and the system frameworks, and it
// can use `NSJSONSerialization` for both directions of the protocol.
//
// Coordinate contract: every coordinate this program accepts is a *global
// display point* — the top-left-origin space `CGEvent` uses. All image-space and
// pixel-space mapping happens in JavaScript, so this program never has to guess
// what the model measured on a screenshot.
//
// Build:
//   clang -O2 -fobjc-arc -o computer-helper computer_helper.m \
//     -framework Foundation -framework CoreGraphics -framework ApplicationServices

#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

#pragma mark - Diagnostics

/// Print one JSON object on stdout and flush, so the parent sees it immediately.
static void emit(NSDictionary *object) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:object
                                                 options:NSJSONWritingSortedKeys
                                                   error:&error];
  if (data == nil) {
    fprintf(stdout, "{\"ok\":false,\"error\":\"failed to encode helper result\"}\n");
  } else {
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
  }
  fflush(stdout);
}

/// Report a failure as JSON and exit non-zero, naming whatever already ran.
static void failWith(NSString *message, NSArray *executed) {
  emit(@{@"ok" : @NO, @"error" : message, @"executed" : executed ?: @[]});
  exit(1);
}

#pragma mark - Key tables

/// macOS virtual key codes for the canonical key names JavaScript emits.
///
/// JavaScript has already translated the model's OpenAI/Codex key names
/// (`ENTER`, `CMD`, `PAGEUP`, …) into these lowercase names, so this table stays
/// a mechanical lookup with no aliasing policy of its own.
static NSDictionary<NSString *, NSNumber *> *keyCodes(void) {
  static NSDictionary<NSString *, NSNumber *> *table = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    table = @{
      @"a" : @0, @"s" : @1, @"d" : @2, @"f" : @3, @"h" : @4, @"g" : @5, @"z" : @6,
      @"x" : @7, @"c" : @8, @"v" : @9, @"b" : @11, @"q" : @12, @"w" : @13,
      @"e" : @14, @"r" : @15, @"y" : @16, @"t" : @17, @"1" : @18, @"2" : @19,
      @"3" : @20, @"4" : @21, @"6" : @22, @"5" : @23, @"equal" : @24, @"9" : @25,
      @"7" : @26, @"minus" : @27, @"8" : @28, @"0" : @29, @"rightbracket" : @30,
      @"o" : @31, @"u" : @32, @"leftbracket" : @33, @"i" : @34, @"p" : @35,
      @"return" : @36, @"l" : @37, @"j" : @38, @"quote" : @39, @"k" : @40,
      @"semicolon" : @41, @"backslash" : @42, @"comma" : @43, @"slash" : @44,
      @"n" : @45, @"m" : @46, @"period" : @47, @"tab" : @48, @"space" : @49,
      @"grave" : @50, @"delete" : @51, @"escape" : @53, @"command" : @55,
      @"shift" : @56, @"capslock" : @57, @"option" : @58, @"control" : @59,
      @"rightshift" : @60, @"rightoption" : @61, @"rightcontrol" : @62,
      @"function" : @63, @"f17" : @64, @"keypaddecimal" : @65,
      @"keypadmultiply" : @67, @"keypadplus" : @69, @"keypadclear" : @71,
      @"keypaddivide" : @75, @"keypadenter" : @76, @"keypadminus" : @78,
      @"f18" : @79, @"f19" : @80, @"keypadequals" : @81, @"keypad0" : @82,
      @"keypad1" : @83, @"keypad2" : @84, @"keypad3" : @85, @"keypad4" : @86,
      @"keypad5" : @87, @"keypad6" : @88, @"keypad7" : @89, @"f20" : @90,
      @"keypad8" : @91, @"keypad9" : @92, @"f5" : @96, @"f6" : @97, @"f7" : @98,
      @"f3" : @99, @"f8" : @100, @"f9" : @101, @"f11" : @103, @"f13" : @105,
      @"f16" : @106, @"f14" : @107, @"f10" : @109, @"f12" : @111, @"f15" : @113,
      @"help" : @114, @"home" : @115, @"pageup" : @116, @"forwarddelete" : @117,
      @"end" : @119, @"pagedown" : @121, @"left" : @123, @"right" : @124,
      @"down" : @125, @"up" : @126,
    };
  });
  return table;
}

/// Modifier names accepted inside an action's `modifiers` array.
static NSDictionary<NSString *, NSNumber *> *modifierFlags(void) {
  static NSDictionary<NSString *, NSNumber *> *table = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    table = @{
      @"cmd" : @(kCGEventFlagMaskCommand),
      @"command" : @(kCGEventFlagMaskCommand),
      @"meta" : @(kCGEventFlagMaskCommand),
      @"super" : @(kCGEventFlagMaskCommand),
      @"shift" : @(kCGEventFlagMaskShift),
      @"alt" : @(kCGEventFlagMaskAlternate),
      @"option" : @(kCGEventFlagMaskAlternate),
      @"opt" : @(kCGEventFlagMaskAlternate),
      @"ctrl" : @(kCGEventFlagMaskControl),
      @"control" : @(kCGEventFlagMaskControl),
      @"fn" : @(kCGEventFlagMaskSecondaryFn),
    };
  });
  return table;
}

#pragma mark - Display facts

/// Describe one display the way the JavaScript coordinate mapper needs it.
static NSDictionary *describeDisplay(CGDirectDisplayID display) {
  CGRect bounds = CGDisplayBounds(display);
  size_t pixelsWide = CGDisplayPixelsWide(display);
  size_t pixelsHigh = CGDisplayPixelsHigh(display);
  double backingScale = bounds.size.width > 0 ? (double)pixelsWide / bounds.size.width : 1.0;
  return @{
    @"id" : @((unsigned int)display),
    @"main" : @(display == CGMainDisplayID()),
    @"originX" : @(bounds.origin.x),
    @"originY" : @(bounds.origin.y),
    @"widthPoints" : @(bounds.size.width),
    @"heightPoints" : @(bounds.size.height),
    @"widthPixels" : @((unsigned long)pixelsWide),
    @"heightPixels" : @((unsigned long)pixelsHigh),
    @"backingScale" : @(backingScale),
  };
}

/// The active displays, main display first.
static NSArray<NSNumber *> *activeDisplays(void) {
  uint32_t count = 0;
  if (CGGetActiveDisplayList(0, NULL, &count) != kCGErrorSuccess || count == 0) return @[];
  CGDirectDisplayID *ids = calloc(count, sizeof(CGDirectDisplayID));
  if (ids == NULL) return @[];
  if (CGGetActiveDisplayList(count, ids, &count) != kCGErrorSuccess) {
    free(ids);
    return @[];
  }
  NSMutableArray<NSNumber *> *main = [NSMutableArray array];
  NSMutableArray<NSNumber *> *rest = [NSMutableArray array];
  for (uint32_t index = 0; index < count; index++) {
    NSNumber *value = @((unsigned int)ids[index]);
    if (ids[index] == CGMainDisplayID()) {
      [main addObject:value];
    } else {
      [rest addObject:value];
    }
  }
  free(ids);
  [main addObjectsFromArray:rest];
  return main;
}

#pragma mark - Permissions

/// Whether this process may post synthetic input events.
static BOOL accessibilityTrusted(void) { return AXIsProcessTrusted(); }

/// Whether this process may read the screen. `CGPreflight…` never prompts,
/// which is what a status probe wants; `CGRequestScreenCaptureAccess` prompts.
static BOOL screenCaptureAllowed(void) {
  if (@available(macOS 10.15, *)) return CGPreflightScreenCaptureAccess();
  return YES;
}

#pragma mark - Input

/// Post one mouse event at a global display point.
static void postMouse(CGEventType type, CGPoint point, CGMouseButton button, CGEventFlags flags,
                      int64_t clickState) {
  CGEventRef event = CGEventCreateMouseEvent(NULL, type, point, button);
  if (event == NULL) return;
  CGEventSetFlags(event, flags);
  CGEventSetIntegerValueField(event, kCGMouseEventClickState, clickState);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
}

/// Post one keyboard event for a virtual key code.
static void postKey(CGKeyCode code, bool down, CGEventFlags flags) {
  CGEventRef event = CGEventCreateKeyboardEvent(NULL, code, down);
  if (event == NULL) return;
  CGEventSetFlags(event, flags);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
}

/// Post one keyboard event carrying literal text.
///
/// Used for `type`, which must deliver arbitrary Unicode rather than a key code.
/// The payload is chunked because one keyboard event cannot carry an arbitrarily
/// long string.
static void postText(NSString *text) {
  NSUInteger length = text.length;
  NSUInteger chunkSize = 16;
  for (NSUInteger index = 0; index < length; index += chunkSize) {
    NSRange range = NSMakeRange(index, MIN(chunkSize, length - index));
    unichar *buffer = calloc(range.length, sizeof(unichar));
    if (buffer == NULL) return;
    [text getCharacters:buffer range:range];
    for (int pass = 0; pass < 2; pass++) {
      CGEventRef event = CGEventCreateKeyboardEvent(NULL, 0, pass == 0);
      if (event == NULL) continue;
      CGEventKeyboardSetUnicodeString(event, (UniCharCount)range.length, buffer);
      CGEventPost(kCGHIDEventTap, event);
      CFRelease(event);
    }
    free(buffer);
    usleep(8000);
  }
}

/// Read a required numeric field from an action object.
static double numberField(NSDictionary *action, NSString *key, NSError **error) {
  id value = action[key];
  if (![value isKindOfClass:[NSNumber class]]) {
    if (error) {
      *error = [NSError
          errorWithDomain:@"computer-helper"
                     code:10
                 userInfo:@{
                   NSLocalizedDescriptionKey :
                       [NSString stringWithFormat:@"action \"%@\" requires numeric \"%@\"",
                                                  action[@"type"] ?: @"?", key]
                 }];
    }
    return 0;
  }
  return [value doubleValue];
}

/// Read a required string field from an action object.
static NSString *stringField(NSDictionary *action, NSString *key, NSError **error) {
  id value = action[key];
  if (![value isKindOfClass:[NSString class]]) {
    if (error) {
      *error = [NSError
          errorWithDomain:@"computer-helper"
                     code:11
                 userInfo:@{
                   NSLocalizedDescriptionKey :
                       [NSString stringWithFormat:@"action \"%@\" requires string \"%@\"",
                                                  action[@"type"] ?: @"?", key]
                 }];
    }
    return nil;
  }
  return value;
}

/// Combine modifier names into one `CGEventFlags` value.
static CGEventFlags combineFlags(NSArray *names, NSError **error) {
  CGEventFlags combined = 0;
  for (id name in names) {
    NSNumber *flag = [name isKindOfClass:[NSString class]] ? modifierFlags()[name] : nil;
    if (flag == nil) {
      if (error) {
        *error = [NSError errorWithDomain:@"computer-helper" code:12
                                 userInfo:@{
                                   NSLocalizedDescriptionKey :
                                       [NSString stringWithFormat:@"unknown modifier key \"%@\"", name]
                                 }];
      }
      return 0;
    }
    combined |= (CGEventFlags)flag.unsignedLongLongValue;
  }
  return combined;
}

/// Map a normalised button name to its CoreGraphics pair.
static bool mouseButtonFor(NSString *name, CGMouseButton *button, CGEventType *down,
                           CGEventType *up) {
  if ([name isEqualToString:@"left"]) {
    *button = kCGMouseButtonLeft;
    *down = kCGEventLeftMouseDown;
    *up = kCGEventLeftMouseUp;
    return true;
  }
  if ([name isEqualToString:@"right"]) {
    *button = kCGMouseButtonRight;
    *down = kCGEventRightMouseDown;
    *up = kCGEventRightMouseUp;
    return true;
  }
  if ([name isEqualToString:@"middle"] || [name isEqualToString:@"center"] ||
      [name isEqualToString:@"wheel"]) {
    *button = kCGMouseButtonCenter;
    *down = kCGEventOtherMouseDown;
    *up = kCGEventOtherMouseUp;
    return true;
  }
  return false;
}

/// Execute one normalised action. Returns a short human-readable record of it.
static NSString *runAction(NSDictionary *action, NSError **error) {
  NSString *type = stringField(action, @"type", error);
  if (type == nil) return nil;

  NSArray *modifiers = [action[@"modifiers"] isKindOfClass:[NSArray class]] ? action[@"modifiers"] : @[];
  CGEventFlags flags = combineFlags(modifiers, error);
  if (error != NULL && *error != nil) return nil;

  if ([type isEqualToString:@"move"]) {
    CGPoint point = CGPointMake(numberField(action, @"x", error), numberField(action, @"y", error));
    if (error != NULL && *error != nil) return nil;
    postMouse(kCGEventMouseMoved, point, kCGMouseButtonLeft, flags, 1);
    return [NSString stringWithFormat:@"move to (%d, %d)", (int)point.x, (int)point.y];
  }

  if ([type isEqualToString:@"click"]) {
    CGPoint point = CGPointMake(numberField(action, @"x", error), numberField(action, @"y", error));
    if (error != NULL && *error != nil) return nil;
    NSString *name = [action[@"button"] isKindOfClass:[NSString class]] ? action[@"button"] : @"left";
    CGMouseButton button;
    CGEventType down, up;
    if (!mouseButtonFor(name, &button, &down, &up)) {
      if (error) {
        *error = [NSError errorWithDomain:@"computer-helper" code:13
                                 userInfo:@{
                                   NSLocalizedDescriptionKey :
                                       [NSString stringWithFormat:@"unsupported mouse button \"%@\"; "
                                                                  @"use left, right or middle",
                                                                  name]
                                 }];
      }
      return nil;
    }
    NSInteger count = [action[@"count"] isKindOfClass:[NSNumber class]]
                          ? MAX(1, [action[@"count"] integerValue])
                          : 1;
    // Park the cursor on the target first: a click event carries its own
    // position, but moving first keeps hover-dependent UI consistent.
    postMouse(kCGEventMouseMoved, point, kCGMouseButtonLeft, flags, 1);
    for (NSInteger step = 1; step <= count; step++) {
      postMouse(down, point, button, flags, step);
      usleep(20000);
      postMouse(up, point, button, flags, step);
      if (step < count) usleep(60000);
    }
    NSString *label = count > 1 ? @"double_click" : @"click";
    NSString *which = button == kCGMouseButtonLeft ? @"left"
                      : button == kCGMouseButtonRight ? @"right"
                                                      : @"middle";
    return [NSString stringWithFormat:@"%@ %@ at (%d, %d)", label, which, (int)point.x, (int)point.y];
  }

  if ([type isEqualToString:@"drag"]) {
    NSArray *rawPath = [action[@"path"] isKindOfClass:[NSArray class]] ? action[@"path"] : nil;
    if (rawPath.count < 2) {
      if (error) {
        *error = [NSError errorWithDomain:@"computer-helper" code:14
                                 userInfo:@{
                                   NSLocalizedDescriptionKey :
                                       @"drag requires a path of at least two points"
                                 }];
      }
      return nil;
    }
    CGPoint *points = calloc(rawPath.count, sizeof(CGPoint));
    if (points == NULL) {
      if (error) {
        *error = [NSError errorWithDomain:@"computer-helper" code:15
                                 userInfo:@{NSLocalizedDescriptionKey : @"out of memory"}];
      }
      return nil;
    }
    for (NSUInteger index = 0; index < rawPath.count; index++) {
      id raw = rawPath[index];
      if (![raw isKindOfClass:[NSArray class]] || [raw count] < 2) {
        free(points);
        if (error) {
          *error = [NSError errorWithDomain:@"computer-helper" code:15
                                   userInfo:@{
                                     NSLocalizedDescriptionKey :
                                         @"each drag path entry must be a [x, y] pair"
                                   }];
        }
        return nil;
      }
      points[index] = CGPointMake([raw[0] doubleValue], [raw[1] doubleValue]);
    }
    NSString *name = [action[@"button"] isKindOfClass:[NSString class]] ? action[@"button"] : @"left";
    CGMouseButton button;
    CGEventType down, up;
    if (!mouseButtonFor(name, &button, &down, &up)) {
      free(points);
      if (error) {
        *error = [NSError errorWithDomain:@"computer-helper" code:16
                                 userInfo:@{NSLocalizedDescriptionKey : @"unsupported drag button"}];
      }
      return nil;
    }
    CGEventType dragged = button == kCGMouseButtonRight   ? kCGEventRightMouseDragged
                          : button == kCGMouseButtonLeft ? kCGEventLeftMouseDragged
                                                         : kCGEventOtherMouseDragged;
    CGPoint start = points[0];
    postMouse(kCGEventMouseMoved, start, kCGMouseButtonLeft, flags, 1);
    usleep(30000);
    postMouse(down, start, button, flags, 1);
    usleep(30000);
    for (NSUInteger index = 1; index < rawPath.count; index++) {
      postMouse(dragged, points[index], button, flags, 1);
      usleep(15000);
    }
    CGPoint end = points[rawPath.count - 1];
    postMouse(up, end, button, flags, 1);
    NSString *summary = [NSString stringWithFormat:@"drag %lu points to (%d, %d)",
                                                   (unsigned long)rawPath.count, (int)end.x,
                                                   (int)end.y];
    free(points);
    return summary;
  }

  if ([type isEqualToString:@"scroll"]) {
    CGPoint point = CGPointMake(numberField(action, @"x", error), numberField(action, @"y", error));
    if (error != NULL && *error != nil) return nil;
    int32_t deltaX = [action[@"deltaX"] isKindOfClass:[NSNumber class]]
                         ? [action[@"deltaX"] intValue]
                         : 0;
    int32_t deltaY = [action[@"deltaY"] isKindOfClass:[NSNumber class]]
                         ? [action[@"deltaY"] intValue]
                         : 0;
    postMouse(kCGEventMouseMoved, point, kCGMouseButtonLeft, flags, 1);
    usleep(20000);
    CGEventRef event =
        CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2, deltaY, deltaX);
    if (event == NULL) {
      if (error) {
        *error = [NSError errorWithDomain:@"computer-helper" code:17
                                 userInfo:@{NSLocalizedDescriptionKey : @"the scroll event could not be created"}];
      }
      return nil;
    }
    CGEventSetFlags(event, flags);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
    return [NSString stringWithFormat:@"scroll by (%d, %d) at (%d, %d)", deltaX, deltaY,
                                      (int)point.x, (int)point.y];
  }

  if ([type isEqualToString:@"keypress"]) {
    NSString *name = stringField(action, @"key", error);
    if (name == nil) return nil;
    NSNumber *code = keyCodes()[name];
    if (code == nil) {
      if (error) {
        *error = [NSError errorWithDomain:@"computer-helper" code:18
                                 userInfo:@{
                                   NSLocalizedDescriptionKey :
                                       [NSString stringWithFormat:@"unknown key \"%@\"", name]
                                 }];
      }
      return nil;
    }
    postKey((CGKeyCode)code.unsignedShortValue, true, flags);
    usleep(12000);
    postKey((CGKeyCode)code.unsignedShortValue, false, flags);
    NSString *suffix = modifiers.count == 0 ? @"" : [@" with " stringByAppendingString:
                                                                 [modifiers componentsJoinedByString:@"+"]];
    return [NSString stringWithFormat:@"keypress %@%@", name, suffix];
  }

  if ([type isEqualToString:@"type"]) {
    NSString *text = stringField(action, @"text", error);
    if (text == nil) return nil;
    postText(text);
    return [NSString stringWithFormat:@"type %lu character(s)", (unsigned long)text.length];
  }

  if ([type isEqualToString:@"wait"]) {
    NSInteger ms = [action[@"ms"] isKindOfClass:[NSNumber class]] ? [action[@"ms"] integerValue] : 2000;
    ms = MAX(0, MIN(ms, 60000));
    usleep((useconds_t)(ms * 1000));
    return [NSString stringWithFormat:@"wait %ldms", (long)ms];
  }

  if (error) {
    *error = [NSError errorWithDomain:@"computer-helper" code:19
                             userInfo:@{
                               NSLocalizedDescriptionKey :
                                   [NSString stringWithFormat:@"unsupported action \"%@\"", type]
                             }];
  }
  return nil;
}

#pragma mark - Entry point

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSArray<NSString *> *arguments = [[NSProcessInfo processInfo] arguments];
    if (arguments.count < 2) {
      failWith(@"usage: computer-helper probe | pointer | act", @[]);
    }
    NSString *command = arguments[1];

    if ([command isEqualToString:@"probe"]) {
      NSMutableArray *displays = [NSMutableArray array];
      for (NSNumber *display in activeDisplays()) {
        [displays addObject:describeDisplay((CGDirectDisplayID)display.unsignedIntValue)];
      }
      emit(@{
        @"ok" : @YES,
        @"platform" : @"darwin",
        @"backend" : @"native",
        @"accessibilityTrusted" : @(accessibilityTrusted()),
        @"screenCaptureAllowed" : @(screenCaptureAllowed()),
        @"displays" : displays,
      });
      return 0;
    }

    if ([command isEqualToString:@"pointer"]) {
      // Reading the cursor is the only way to tell whether a posted mouse event
      // was actually delivered: without Accessibility permission CGEventPost
      // succeeds and does nothing at all.
      CGEventRef event = CGEventCreate(NULL);
      CGPoint location = event != NULL ? CGEventGetLocation(event) : CGPointZero;
      if (event != NULL) CFRelease(event);
      emit(@{
        @"ok" : @YES,
        @"x" : @(location.x),
        @"y" : @(location.y),
        @"accessibilityTrusted" : @(accessibilityTrusted()),
      });
      return 0;
    }

    if ([command isEqualToString:@"act"]) {
      NSData *input = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
      NSError *error = nil;
      id root = [NSJSONSerialization JSONObjectWithData:input options:0 error:&error];
      if (![root isKindOfClass:[NSDictionary class]] ||
          ![((NSDictionary *)root)[@"actions"] isKindOfClass:[NSArray class]]) {
        failWith(@"act expects {\"actions\": [...]} on stdin", @[]);
      }
      NSArray *actions = ((NSDictionary *)root)[@"actions"];
      NSMutableArray *executed = [NSMutableArray array];
      for (NSUInteger index = 0; index < actions.count; index++) {
        NSDictionary *action = actions[index];
        if (![action isKindOfClass:[NSDictionary class]]) {
          failWith([NSString stringWithFormat:@"action %lu is not an object", (unsigned long)index],
                   executed);
        }
        NSError *actionError = nil;
        NSString *summary = runAction(action, &actionError);
        if (summary == nil) {
          failWith([NSString stringWithFormat:@"action %lu (%@) failed: %@", (unsigned long)index,
                                              action[@"type"] ?: @"?", actionError.localizedDescription],
                   executed);
        }
        [executed addObject:@{
          @"index" : @((unsigned long)index),
          @"type" : action[@"type"] ?: @"?",
          @"summary" : summary,
        }];
      }
      emit(@{@"ok" : @YES, @"executed" : executed});
      return 0;
    }

    failWith([NSString stringWithFormat:@"unknown command \"%@\"", command], @[]);
  }
  return 0;
}
