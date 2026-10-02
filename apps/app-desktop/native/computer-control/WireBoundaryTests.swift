// Appended to the verbatim Foundation-only functions extracted from Helper.swift.
// This tests real Foundation JSON/NSNumber behavior, NOT AppKit/Security or authority.
// Test-only conversion of synthetic interval inputs to the production typed DTO
// producer. No such interval/phase/status fields are accepted by the helper wire.
func testSourceSpan(_ value: Object?) -> SourceSpan? {
    guard let value = value, let phaseName = value["phase"] as? String, let phase = SourcePhase(rawValue: phaseName),
          let statusName = value["status"] as? String, let status = SourceStatus(rawValue: statusName),
          let start = wireInteger(value["startUs"], max: 9_007_199_254_740_991),
          let end = wireInteger(value["endUs"], max: 9_007_199_254_740_991) else { return nil }
    return SourceSpan(phase: phase, startUs: UInt64(start), endUs: UInt64(end), status: status)
}
func testSourceDTO(_ value: Object) -> Object? {
    guard let requestId = value["requestId"] as? String, let methodName = value["method"] as? String,
          let method = SourceMethod(rawValue: methodName), let root = testSourceSpan(value["root"] as? Object) else { return nil }
    let api = testSourceSpan(value["api"] as? Object)
    if value.keys.contains("api") && api == nil { return nil }
    return SourceClock().dto(requestId: requestId, method: method, root: root, api: api)
}
// Privacy policy is extracted from production, not an independent model. Native
// AX error/status mapping and modal lifecycle still require the packaged Mac.
for role in publicAXRoles where role != "AXWindow" {
    precondition(publicAXClassification(role, ""))
    precondition(!publicAXClassification(role, nil))
    precondition(!publicAXClassification(role, "AXUnreviewedSubrole"))
    precondition(!publicAXClassification(role, "AXSecureTextField"))
}
precondition(publicAXClassification("AXWindow", "AXStandardWindow"))
for subrole in ["", "AXDialog", "AXSystemDialog", "AXUnknown"] {
    precondition(!publicAXClassification("AXWindow", subrole))
}
for role in ["AXSheet", "AXUnknown", "SECRET_SENTINEL_ROLE"] {
    precondition(!publicAXClassification(role, ""))
}
precondition(!publicAXClassification(nil, ""))
precondition(publicAXClassification("AXTextField", "AXSearchField"))
print("PASS closed AX role/subrole privacy policy; missing/unknown classification and sheets refuse. Foundation only, not native AX reads.")
var timingResponses: [Object] = []
let vectors = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [Object]
var checked = 0
for vector in vectors {
    let kind = vector["kind"] as! String
    let value = vector["value"] as? Object ?? [:]
    let valid: Bool
    switch kind {
    case "identity": valid = validWireIdentity(value)
    case "target": valid = validWireTarget(value)
    case "grant": valid = validWireGrant(value)
    case "command": valid = validWireCommand(value)
    case "request": valid = validWireRequest(value)
    case "timingSource":
        let dto = testSourceDTO(value); valid = dto != nil
        if let dto = dto, let method = value["method"] as? String {
            var envelope: Object = ["id": value["requestId"]!, "ok": true, "result": Object(), "diagnostics": dto]
            if method == "capabilities" { envelope["diagnosticsVersion"] = 1 }
            timingResponses.append(["envelope": envelope, "method": method, "expectedTiming": true])
        }
    default: fatalError("Unknown test kind")
    }
    precondition(valid == (vector["expected"] as! Bool), "Wire mismatch: \(vector["name"]!)")
    checked += 1
}
// JSON itself cannot encode NaN/Infinity; exercise these Foundation inputs directly.
for value in [Double.nan, Double.infinity, -Double.infinity] {
    precondition(wireNumber(NSNumber(value: value)) == nil)
    precondition(wireInteger(NSNumber(value: value)) == nil)
}
for value in [NSNumber(value: 0), NSNumber(value: 1), NSNumber(value: 0.0), NSNumber(value: 1.0)] {
    precondition(wireBool(value) == nil, "CFNumber must not become a Boolean")
}
for value in [NSNumber(value: true), NSNumber(value: false)] {
    precondition(wireNumber(value) == nil && wireInteger(value) == nil, "CFBoolean must not become a number")
}
precondition(wireBool(NSNumber(value: true)) == true && wireBool(NSNumber(value: false)) == false)
precondition(wireInteger(NSNumber(value: 1.0)) == 1) // Mathematical integers match z.number().int().
precondition(wireInteger(NSNumber(value: 1.5)) == nil)
precondition(wireInteger(NSNumber(value: 1_800_000_000_000.5)) == nil, "Incoming fractional epoch milliseconds must be refused, not rounded")
precondition(wireNumber("1") == nil && wireBool("true") == nil)
// Extreme numeric JSON input must either be rejected by Foundation or by the wire gate.
for raw in ["{\"x\":1e999}", "{\"x\":-1e999}", "{\"x\":NaN}", "{\"x\":Infinity}"] {
    if let decoded = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? Object {
        precondition(wireNumber(decoded["x"]) == nil)
    }
}
let timestamp = now()
precondition(timestamp.isFinite && timestamp >= 0 && timestamp.rounded(.down) == timestamp)
let encoded = try JSONSerialization.data(withJSONObject: ["capturedAt": timestamp, "monotonicMs": monotonic()])
let decoded = try JSONSerialization.jsonObject(with: encoded) as! Object
precondition(wireInteger(decoded["capturedAt"]) == timestamp)
precondition(wireNumber(decoded["monotonicMs"]) != nil)
print("PASS \(checked) actual Foundation wire vectors, strict NSNumber types, non-finite rejection and integer timestamp roundtrip. No AppKit/Security compilation or native authority execution.")


// Real DispatchTime-based production context/response tests. These invoke no AX,
// capture, permission, signature, grant, model, or helper process operations.
let clock = SourceClock()
let otherClock = SourceClock()
precondition(UUID(uuidString: clock.instanceId) != nil && UUID(uuidString: clock.clockId) != nil)
precondition(clock.instanceId != clock.clockId && clock.instanceId != otherClock.instanceId && clock.clockId != otherClock.clockId)
let firstTick = clock.tick()!; let secondTick = clock.tick()!
precondition(secondTick >= firstTick && secondTick <= 9_007_199_254_740_991)
precondition(SourceSpan(phase: .request, startUs: UInt64.max, endUs: 0, status: .returned).wire == nil)
precondition(SourceSpan(phase: .request, startUs: 0, endUs: UInt64.max, status: .returned).wire == nil)
let baselineCommand = vectors.first { $0["name"] as? String == "baseline command" }!["value"] as! Object
let baselineGrant = vectors.first { $0["name"] as? String == "baseline grant" }!["value"] as! Object
let privateContent: Object = ["value": "PRIVATE_CONTENT_VALUE", "ref": "PRIVATE_CONTENT_REF", "target": "PRIVATE_CONTENT_TARGET",
    "name": "PRIVATE_CONTENT_NAME", "goal": "PRIVATE_CONTENT_GOAL", "frame": "PRIVATE_CONTENT_FRAME", "error": "PRIVATE_CONTENT_ERROR", "input": false]
func sourceRequest(_ method: SourceMethod, action: String = "invoke", diagnostics: Bool? = true) -> Object {
    var command = baselineCommand
    var target = (command["action"] as! Object)["target"] as! Object
    for key in ["appId", "processInstanceId", "windowId", "windowInstanceId"] { target[key] = "PRIVATE_CONTENT_TARGET" }
    var operation: Object = ["kind": action, "target": target]
    if action != "observe" { operation["observationId"] = "PRIVATE_CONTENT_OBSERVATION" }
    if ["invoke", "setValue", "select", "scroll"].contains(action) { operation["ref"] = "PRIVATE_CONTENT_REF" }
    if action == "setValue" { operation["text"] = "PRIVATE_CONTENT_TEXT" }
    if action == "scroll" { operation["deltaY"] = 1 }
    command["action"] = operation
    var payload: Object = [:]
    switch method {
    case .start:
        var grant = baselineGrant
        grant["goal"] = "PRIVATE_CONTENT_GOAL"; grant["requester"] = "PRIVATE_CONTENT_NAME"
        payload = ["grant": grant, "leaseId": "PRIVATE_CONTENT_LEASE"]
    case .beginApproval, .execute: payload = ["command": command, "leaseId": "PRIVATE_CONTENT_LEASE"]
    case .endApproval: payload = ["command": command, "leaseId": "PRIVATE_CONTENT_LEASE", "approved": false]
    default: break
    }
    var request: Object = ["id": "request_1-source", "method": method.rawValue, "payload": payload]
    if let diagnostics = diagnostics { request["diagnostics"] = diagnostics }
    return request
}
@discardableResult
func saveResponse(_ request: Object, _ context: SourceRequestTiming?, _ expectedTiming: Bool, result: Any = privateContent) -> Object {
    let response = privateResponse(requestId: request["id"] as! String, method: request["method"] as! String, result: result, timing: context)
    precondition((response["diagnostics"] != nil) == expectedTiming)
    timingResponses.append(["envelope": response, "method": request["method"]!, "expectedTiming": expectedTiming])
    return response
}
for method in [SourceMethod.capabilities, .listTargets, .start, .beginApproval, .endApproval, .execute] {
    for flag: Bool? in [nil, false, true] {
        let request = sourceRequest(method, diagnostics: flag)
        precondition(validWireRequest(request))
        let context = SourceRequestTiming(request: request, clock: clock)
        precondition((context != nil) == (flag == true))
        let response = saveResponse(request, context, flag == true)
        precondition(NSDictionary(dictionary: response["result"] as! Object).isEqual(to: privateContent))
        if method == .capabilities {
            precondition(wireInteger(response["diagnosticsVersion"]) == 1)
            precondition((response["result"] as! Object)["diagnosticsVersion"] == nil)
        } else { precondition(response["diagnosticsVersion"] == nil) }
        if let dto = response["diagnostics"] as? Object {
            precondition(dto["instanceId"] as? String == clock.instanceId && dto["clockId"] as? String == clock.clockId)
            let encodedDTO = try JSONSerialization.data(withJSONObject: dto)
            precondition(!String(data: encodedDTO, encoding: .utf8)!.contains("PRIVATE_CONTENT"))
        }
        precondition(context?.finish() == nil, "Only one bounded completed DTO may be consumed")
    }
}
for (kind, phase) in [("observe", SourcePhase.observe_request), ("capture", SourcePhase.capture_request)] {
    let request = sourceRequest(.execute, action: kind)
    let context = SourceRequestTiming(request: request, clock: clock)!
    let response = saveResponse(request, context, true)
    let spans = (response["diagnostics"] as! Object)["spans"] as! [Object]
    precondition(spans.count == 1 && spans[0]["phase"] as? String == phase.rawValue)
}
for (kind, phase) in [("setValue", SourcePhase.api_set_value), ("invoke", SourcePhase.api_invoke), ("select", SourcePhase.api_select), ("scroll", SourcePhase.api_scroll)] {
    for returned in [true, false] {
        let request = sourceRequest(.execute, action: kind)
        let context = SourceRequestTiming(request: request, clock: clock)!
        context.beginAPI(phase); context.endAPI(returned: returned)
        let response = saveResponse(request, context, true)
        let spans = (response["diagnostics"] as! Object)["spans"] as! [Object]
        precondition(spans.count == 2 && spans[0]["phase"] as? String == "request" && spans[0]["status"] as? String == "returned")
        precondition(spans[1]["phase"] as? String == phase.rawValue && spans[1]["status"] as? String == (returned ? "returned" : "failed"))
    }
}
let refusalRequest = sourceRequest(.start)
let refusal = saveResponse(refusalRequest, SourceRequestTiming(request: refusalRequest, clock: clock), true, result: false)
precondition(((refusal["diagnostics"] as! Object)["spans"] as! [Object])[0]["status"] as? String == "returned", "Structured refusal is a returned handler, not a delivery claim")
let apiRequest = sourceRequest(.execute)
let pendingCall = SourceRequestTiming(request: apiRequest, clock: clock)!
pendingCall.beginAPI(.api_invoke)
saveResponse(apiRequest, pendingCall, false) // Cannot finish an unreturned source API span.
pendingCall.endAPI(returned: true)
precondition(pendingCall.finish() == nil)
let duplicateAPI = SourceRequestTiming(request: apiRequest, clock: clock)!
duplicateAPI.beginAPI(.api_invoke); duplicateAPI.endAPI(returned: true)
duplicateAPI.beginAPI(.api_invoke); duplicateAPI.endAPI(returned: true)
saveResponse(apiRequest, duplicateAPI, false) // Never grow beyond one root + one API.
let unmatchedEnd = SourceRequestTiming(request: apiRequest, clock: clock)!
unmatchedEnd.endAPI(returned: false)
saveResponse(apiRequest, unmatchedEnd, false)
let invalidRoot = SourceRequestTiming(request: sourceRequest(.execute, action: "capture"), clock: clock)!
invalidRoot.beginAPI(.api_set_value); invalidRoot.endAPI(returned: true)
precondition(invalidRoot.finish() == nil)
var otherRequest = apiRequest; otherRequest["id"] = "different_request"
saveResponse(otherRequest, SourceRequestTiming(request: apiRequest, clock: clock), false)
let fakeMethodRequest = sourceRequest(.listTargets)
saveResponse(fakeMethodRequest, SourceRequestTiming(request: apiRequest, clock: clock), false)
// Operation traps in this extraction: direct protocol calls cannot construct the
// operational backend. AppKit/AX/SCK APIs are not even linked into this executable.
final class Broker {
    init() { fatalError("Operational Broker construction from probe protocol") }
    func listTargets() -> [Object] { fatalError("Target read from probe protocol") }
    func start(_ payload: Object) -> Bool { fatalError("Operational start") }
    func execute(_ payload: Object, timing: SourceRequestTiming? = nil) -> Object { fatalError("Operational execute") }
}
var probeCount = 0
func checkProbe(_ request: Object) {
    guard let response = probeOnlyResponse(request, clock: clock) else {
        precondition(!validWireRequest(request), "Valid direct request must get a bounded refusal/probe")
        return
    }
    precondition(validWireRequest(request))
    let method = request["method"] as! String
    switch method {
    case "capabilities":
        let caps = response["result"] as! Object
        for bit in ["axRead", "semanticActions", "windowCapture", "input"] { precondition(wireBool(caps[bit]) == false) }
        precondition(caps["accessibilityPermission"] as? String == "unknown")
        precondition(caps["capturePermission"] as? String == "unknown")
        precondition(caps["limitations"] as? [String] == ["Native authority disabled: parent loaded-framework proof is unenforced."])
        precondition(wireInteger(response["diagnosticsVersion"]) == 1)
    case "listTargets": precondition((response["result"] as! [Object]).isEmpty)
    case "start", "beginApproval", "endApproval": precondition(wireBool(response["result"]) == false)
    case "execute":
        let receipt = response["result"] as! Object
        let command = (request["payload"] as! Object)["command"] as! Object
        precondition(Set(receipt.keys) == Set(["commandId", "code", "outcome"]))
        precondition(receipt["commandId"] as? String == command["commandId"] as? String)
        precondition(receipt["code"] as? String == "denied" && receipt["outcome"] as? String == "not_executed")
    default: fatalError("Unknown method admitted")
    }
    let timed = wireBool(request["diagnostics"]) == true
    precondition((response["diagnostics"] != nil) == timed)
    if let dto = response["diagnostics"] as? Object {
        let spans = dto["spans"] as! [Object]
        precondition(spans.count == 1 && !(spans[0]["phase"] as! String).hasPrefix("api_"))
    }
    timingResponses.append(["envelope": response, "method": method, "expectedTiming": timed, "probe": true])
    probeCount += 1
}
// Replay direct wire vectors without Main, API, consent UI, permission or lease
// service. Also exercise every valid action, including raw click/key requests.
for vector in vectors {
    let value = vector["value"] as? Object ?? [:]
    if vector["kind"] as? String == "request" { checkProbe(value) }
    if vector["kind"] as? String == "command", validWireCommand(value) {
        for flag: Bool? in [nil, false, true] {
            var request: Object = ["id": "direct", "method": "execute", "payload": ["command": value, "leaseId": "caller-chosen"]]
            if let flag = flag { request["diagnostics"] = flag }
            checkProbe(request)
        }
    }
}
// A caller may assert consent/control/capture and repeat the full conversation;
// none of it creates state or changes the empty discovery/capabilities response.
for _ in 0..<2 {
    for method in [SourceMethod.capabilities, .listTargets, .start, .beginApproval, .endApproval, .execute] {
        var request = sourceRequest(method)
        var payload = request["payload"] as! Object
        if method == .start {
            var grant = payload["grant"] as! Object
            grant["allowControl"] = true; grant["allowCapture"] = true
            grant["expiresAt"] = now() + 60_000
            payload["grant"] = grant
        }
        if method == .endApproval { payload["approved"] = true }
        request["payload"] = payload
        checkProbe(request)
    }
}
print("PASS \(probeCount) direct production probe/refusal responses with operation traps; no Broker construction, target reads or API spans. No native SDK execution.")
try JSONSerialization.data(withJSONObject: timingResponses).write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
print("PASS private timing default-off/negotiation, source intervals/nesting, status/privacy and bounded one-shot response tests. Foundation/Dispatch only; no native API dispatch or delivery evidence.")
