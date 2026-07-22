import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, type WorkoutInput, type RecoverySessionStatus, type TrainingConfig } from "@/lib/api"

export function useWorkouts() {
  return useQuery({ queryKey: ["workouts"], queryFn: api.workouts })
}

export function useTrainingConfig() {
  return useQuery({ queryKey: ["trainingConfig"], queryFn: api.trainingConfig })
}

export function useUpdateTrainingConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<TrainingConfig>) => api.updateTrainingConfig(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["trainingConfig"] }),
  })
}

export function useRecoveryTools() {
  return useQuery({ queryKey: ["recoveryTools"], queryFn: api.recoveryTools })
}

export function useRecoverySessions() {
  return useQuery({ queryKey: ["recoverySessions"], queryFn: api.recoverySessions })
}

// One shared invalidation point for every Workouts-tab write — mirrors the legacy
// app.js pattern of just calling renderWorkoutsTab() again after any mutation,
// except each of these only refetches the one list that actually changed.
export function useWorkoutMutations() {
  const qc = useQueryClient()
  const invalidateWorkouts = () => qc.invalidateQueries({ queryKey: ["workouts"] })
  const invalidateRecovery = () => qc.invalidateQueries({ queryKey: ["recoverySessions"] })

  const createWorkout = useMutation({
    mutationFn: (body: WorkoutInput) => api.createWorkout(body),
    onSuccess: invalidateWorkouts,
  })
  const updateWorkout = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<WorkoutInput> }) => api.updateWorkout(id, body),
    onSuccess: invalidateWorkouts,
  })
  const deleteWorkout = useMutation({
    mutationFn: (id: string) => api.deleteWorkout(id),
    onSuccess: invalidateWorkouts,
  })
  const updateRecoveryStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: RecoverySessionStatus }) =>
      api.updateRecoverySessionStatus(id, status),
    onSuccess: invalidateRecovery,
  })
  const deleteRecoverySession = useMutation({
    mutationFn: (id: string) => api.deleteRecoverySession(id),
    onSuccess: invalidateRecovery,
  })

  return { createWorkout, updateWorkout, deleteWorkout, updateRecoveryStatus, deleteRecoverySession }
}
