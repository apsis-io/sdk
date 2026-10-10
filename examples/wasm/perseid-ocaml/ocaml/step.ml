(* ADR-0075's step contract, in OCaml 5, as the feasibility probe for
   "can effect handlers express reconciliation, through the whole toolchain".

   Three-valued observation, Emit-as-obligation, explicit outcome, and a
   handler that supplies the world so the step itself touches nothing.

   Deliberately uses NO OCaml libraries - see README, "Arch ocamlfind vs opam".
   That is also why there are no JS-callable exports here: the component runs
   the whole thing once from run(). Callable exports are the next gate. *)

type 'a obs = Known of 'a | Absent | Unknown
type outcome = Yield | Quiesce | Terminate

type _ Effect.t +=
  | Get : string -> int obs Effect.t
  | Emit : string -> unit Effect.t

let step () =
  match Effect.perform (Get "replicas") with
  | Absent -> Terminate
  | Unknown -> Yield
  | Known have ->
      let want = 3 in
      if have < want then begin
        Effect.perform (Emit (Printf.sprintf "scale +%d" (want - have)));
        Yield
      end
      else if have > want then begin
        Effect.perform (Emit (Printf.sprintf "scale -%d" (have - want)));
        Yield
      end
      else begin
        Effect.perform (Emit "status readyReplicas=3");
        Quiesce
      end

(* The runtime half: intercepts effects, collects obligations, and never lets
   the step reach the world. `lookup` is annotated because without it the GADT
   refinement (a = int obs) has nothing to unify against and the compiler
   reports "this instance of int obs is ambiguous". *)
let run_step (lookup : string -> int obs) =
  let acts = ref [] in
  let open Effect.Deep in
  let o =
    try_with step ()
      { effc =
          (fun (type a) (e : a Effect.t) ->
            match e with
            | Get k ->
                Some (fun (c : (a, outcome) continuation) -> continue c (lookup k))
            | Emit s ->
                Some
                  (fun (c : (a, outcome) continuation) ->
                    acts := s :: !acts;
                    continue c ())
            | _ -> None) }
  in
  (o, List.rev !acts)

let name = function
  | Yield -> "Yield"
  | Quiesce -> "Quiesce"
  | Terminate -> "Terminate"

let case label lookup =
  let o, acts = run_step lookup in
  Printf.printf "%-10s -> %-9s acts=[%s]\n" label (name o)
    (String.concat "; " acts)

(* Five arms: positive, negative, and the discrimination that matters -
   Absent (it is gone) must not behave like Unknown (cannot tell). *)
let () =
  case "below" (fun _ -> Known 1);
  case "equal" (fun _ -> Known 3);
  case "above" (fun _ -> Known 5);
  case "absent" (fun _ -> Absent);
  case "unknown" (fun _ -> Unknown)
